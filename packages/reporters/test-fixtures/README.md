# Test fixtures of the reporters

`sarif-schema-2.1.0.json` is the JSON schema of SARIF 2.1.0 as OASIS publishes it (Errata 01, OASIS
Standard), unmodified, downloaded from

    https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json

It is read by the tests only (`src/sarif.test.ts`, `e2e/ci.spec.ts`) so that the SARIF the tool
writes is validated against the official schema without any network access. It is not part of a
built package (`files` of the package lists `dist` only).

Copyright © OASIS Open. The SARIF specification and its schemas are published under the OASIS IPR
Policy (https://www.oasis-open.org/policies-guidelines/ipr/), "RF on RAND Terms" mode for the SARIF
Technical Committee. The notice OASIS puts in its specifications allows the document to be copied
and furnished to others provided the copyright notice is kept; the schema file itself carries no
notice, so it is given here. Whether keeping a copy in this repository suits the licence the owner
chooses for the project is an owner decision: the alternative is to download the file in CI before
the tests run, which the tests do not do today.
