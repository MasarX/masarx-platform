FROM postgres:15-bookworm@sha256:86de064c5c6a497cfffd49c05327128d2939ad50f2c414c5cfa2fa36308af58c

ARG MASARX_PG_PROVE_PACKAGE_VERSION=3.36-2
ARG MASARX_TOOLCHAIN_POLICY_SHA
ARG MASARX_TOOLCHAIN_DOCKERFILE_SHA

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      "libtap-parser-sourcehandler-pgtap-perl=${MASARX_PG_PROVE_PACKAGE_VERSION}" \
    && test "$(dpkg-query -W -f='${Version}' libtap-parser-sourcehandler-pgtap-perl)" = "${MASARX_PG_PROVE_PACKAGE_VERSION}" \
    && test "$(pg_prove --version)" = "pg_prove 3.36" \
    && rm -rf /var/lib/apt/lists/*

LABEL org.nzxmhryhtqlzoshjkyozkpup.example.invalidntract="pr-validation-pg-prove-toolchain-v1" \
      org.masarx.pg-prove.package-version="${MASARX_PG_PROVE_PACKAGE_VERSION}" \
      org.masarx.pg-prove.psql-major="15" \
      org.masarx.pg-prove.policy-sha256="${MASARX_TOOLCHAIN_POLICY_SHA}" \
      org.masarx.pg-prove.dockerfile-sha256="${MASARX_TOOLCHAIN_DOCKERFILE_SHA}"

ENTRYPOINT []
