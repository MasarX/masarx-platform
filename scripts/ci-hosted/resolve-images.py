"""Anonymous manifest-only reads; no Docker, installation, Git or image execution."""
import argparse
import concurrent.futures
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

IMAGES = [
    ('database', 'supabase/postgres', '17.6.1.014', 'scripts/ops/workspace/local-db-start.js:74'),
    ('auth', 'supabase/gotrue', 'v2.196.0', 'tests/fixtures/ci/supabase-services-2.116.0.json:1'),
    ('storage', 'supabase/storage-api', 'v1.70.3', 'tests/fixtures/ci/supabase-services-2.116.0.json:1'),
    ('gateway', 'supabase/kong', '2.8.1', 'tests/unit/ops/cloud-pool-db-local.test.js:548'),
]
ACCEPT = ', '.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
                    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])


def request(url, token=None):
    headers = {'User-Agent': 'registry-manifest-client/1.0', 'Accept': ACCEPT}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as response:
        return response.read(4 * 1024 * 1024), dict(response.headers)


def resolve(spec):
    role, image, tag, provenance = spec
    endpoint = f'https://public.ecr.aws/v2/{image}/manifests/{tag}'
    record = {'role': role, 'image': image, 'tag': tag, 'source': provenance, 'registry_endpoint': endpoint,
              'digest': 'PIN_NEEDED', 'time_utc': datetime.now(timezone.utc).isoformat(), 'attempts': []}
    try:
        token_url = 'https://public.ecr.aws/token/?' + urllib.parse.urlencode({'service': 'public.ecr.aws', 'scope': f'repository:{image}:pull'})
        payload, _ = request(token_url)
        token = json.loads(payload)['token']
        manifest, headers = request(endpoint, token)
        digest = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        reported = next((value for key, value in headers.items() if key.lower() == 'docker-content-digest'), digest)
        if reported != digest:
            raise ValueError('manifest digest header mismatch')
        record.update(digest=digest, media_type=json.loads(manifest).get('mediaType'),
                      architectures=[item.get('platform', {}) for item in json.loads(manifest).get('manifests', [])])
        return record, manifest
    except Exception as error:
        record['attempts'].append({'endpoint': endpoint, 'error': type(error).__name__, 'status': getattr(error, 'code', None)})
        return record, None


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--clock-utc', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = root / 'registry-evidence'
    evidence.mkdir(exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(resolve, IMAGES))
    records = []
    for record, manifest in results:
        record['clock_tool_batch_start_utc'] = args.clock_utc
        records.append(record)
        if manifest is not None:
            (evidence / (record['role'] + '.manifest.json')).write_bytes(manifest)
    (evidence / 'resolution.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(records, indent=2))
