# Dependency X-Ray

A static browser app for reading Composer, npm and Python dependency manifests. Run `python3 scripts/build.py` to copy the site to `dist/`. There are no credentials, server components or scheduled data refreshes.

Supported inputs include `composer.lock`, npm v1–v3 `package-lock.json`, `Pipfile.lock`, pinned requirements text, and Composer/npm manifests containing exact versions. Version ranges, local paths and unsupported tags are skipped. No environment markers are evaluated. Duplicate ecosystem/name/version tuples are joined, while coexisting versions remain separate. Input is capped at 4 MiB and 2,500 packages.

Files are parsed in the browser. Selecting **Check selected on OSV** sends only the explicitly selected package names, ecosystems and exact versions to [OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/). The screen shows request coverage, failures and advisories. Cancelled scans preserve completed results. **Check release** sends a single package name to [deps.dev](https://docs.deps.dev/api/v3/) for npm or PyPI, or [Packagist's metadata endpoint](https://packagist.org/apidoc) for Composer packages. The release comparison reports older numeric pins where both sides can be compared reliably. Rich platform compatibility and recommended upgrade paths require a package manager.

The sample includes three historically affected versions, and opening it is local. Source advisories link to OSV. Reports download locally as JSON. A lack of known OSV matches does not determine whether a package is safe.

To compare a newer inventory against an earlier lockfile, open the newer file first and select the earlier file under **Compare with an earlier lockfile**. The browser shows added packages, newly present versions, unchanged versions, and earlier versions no longer present. Coexisting versions are tracked separately. The JSON report includes the comparison and the number of skipped earlier entries. Both inputs must use the same supported format. Version changes do not imply that an upgrade is compatible or safe.
