-- pgTAP: Canonical geography seed (cities + districts) with centroids

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
    (SELECT COUNT(*) > 0 FROM canonical_cities),
    'canonical_cities is seeded'
);

SELECT ok(
    (SELECT COUNT(*) > 0 FROM canonical_districts),
    'canonical_districts is seeded'
);

SELECT ok(
    (SELECT COUNT(*) FILTER (WHERE source_city_id IS NOT NULL) > 0 FROM canonical_cities),
    'canonical_cities include source ids'
);

SELECT ok(
    (SELECT COUNT(*) FILTER (WHERE source_district_id IS NOT NULL) > 0 FROM canonical_districts),
    'canonical_districts include source ids'
);

SELECT ok(
    (SELECT COUNT(*) > 0 FROM canonical_cities WHERE centroid IS NOT NULL),
    'canonical_cities include centroids'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM canonical_districts cd
        JOIN canonical_cities c ON c.id = cd.city_id AND c.organization_id = cd.organization_id
        WHERE lower(c.name_canonical) = 'riyadh'
          AND lower(cd.name_canonical) LIKE 'al amal%'
          AND cd.centroid IS NOT NULL
    ),
    'Riyadh / Al Amal district seeded with centroid'
);

SELECT finish();

ROLLBACK;
