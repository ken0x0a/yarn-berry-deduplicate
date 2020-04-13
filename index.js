// const lockfile = require('@yarnpkg/lockfile');
const yarnParsers = require('@yarnpkg/parsers');
const semver = require('semver');

const parseYarnLock = file => yarnParsers.parseSyml(file);

const extractPackages = (json, includePackages = [], excludePackages = []) => {
    const packages = {};
    const re = /^(.*)@(?:([^:]*):)?([^@]*?)$/;

    Object.keys(json).forEach(key => {
        if (key === '__metadata') return;
        const pkg = json[key];

        // ignore non hard links
        if (pkg.linkType !== 'hard') return;

        let packageName,
            requestedSources = new Set(),
            requestedVersions = [];

        key.split(', ').forEach(part => {
            const match = part.match(re);

            let requestedVersion, requestedSource;

            // TODO: make this ignore other urls like:
            //      git...
            //      user/repo
            //      tag
            //      path/path/path
            if (match) {
                [, packageName, requestedSource, requestedVersion] = match;
            } else {
                console.log(part);
                // If there is no match, it means there is no version specified. According to the doc
                // this means "*" (https://docs.npmjs.com/files/package.json#dependencies)
                packageName = part;
                requestedSource = 'npm';
                requestedVersion = '*';
            }

            // If there is a list of package names, only process those.
            if (includePackages.length > 0 && !includePackages.includes(packageName)) return;

            if (excludePackages.length > 0 && excludePackages.includes(packageName)) return;

            requestedSources.add(requestedSource);
            requestedVersions.push(requestedVersion);
        });

        // ignore non npm sources
        if (requestedSources.size !== 1 || !requestedSources.has('npm')) return;

        packages[packageName] = packages[packageName] || [];
        packages[packageName].push({
            key,
            pkg,
            name: packageName,
            requestedVersions,
            installedVersion: pkg.version,
            satisfiedBy: new Set(),
        });
    });
    return packages;
};

const computePackageInstances = (packages, name, useMostCommon) => {
    // Instances of this package in the tree
    const packageInstances = packages[name];

    // Extract the list of unique versions for this package
    const versions = packageInstances.reduce((versions, packageInstance) => {
        if (packageInstance.installedVersion in versions) return versions;
        versions[packageInstance.installedVersion] = {
            pkg: packageInstance.pkg,
            satisfies: new Set(),
        };
        return versions;
    }, {});

    // Link each package instance with all the versions it could satisfy.
    Object.keys(versions).forEach(version => {
        const satisfies = versions[version].satisfies;
        packageInstances.forEach(packageInstance => {
            // We can assume that the installed version always satisfied the requested version.
            packageInstance.satisfiedBy.add(packageInstance.installedVersion);
            // In some cases the requested version is invalid form a semver point of view (for
            // example `sinon@next`). Just ignore those cases, they won't get deduped.

            if (
                packageInstance.requestedVersions.some(
                    requestedVersion =>
                        semver.validRange(requestedVersion) &&
                        semver.satisfies(version, requestedVersion)
                )
            ) {
                satisfies.add(packageInstance);
                packageInstance.satisfiedBy.add(version);
            }
        });
    });

    // Sort the list of satisfied versions
    packageInstances.forEach(packageInstance => {
        // Save all versions for future reference
        packageInstance.versions = versions;

        // Compute the versions that actually satisfy this instance
        const candidateVersions = Array.from(packageInstance.satisfiedBy);
        candidateVersions.sort((versionA, versionB) => {
            if (useMostCommon) {
                // Sort verions based on how many packages it satisfies. In case of a tie, put the
                // highest version first.
                if (versions[versionB].satisfies.size > versions[versionA].satisfies.size) return 1;
                if (versions[versionB].satisfies.size < versions[versionA].satisfies.size)
                    return -1;
            }
            return semver.rcompare(versionA, versionB);
        });
        packageInstance.satisfiedBy = candidateVersions;

        // The best package is always the first one in the list thanks to the sorting above.
        packageInstance.bestVersion = candidateVersions[0];
    });

    return packageInstances;
};

const getDuplicatedPackages = (packages, { useMostCommon }) => {
    return Object.keys(packages)
        .reduce(
            (acc, name) => acc.concat(computePackageInstances(packages, name, useMostCommon)),
            []
        )
        .filter(({ bestVersion, installedVersion }) => bestVersion !== installedVersion);
};

module.exports.listDuplicates = (
    yarnLock,
    { includePackages = [], excludePackages = [], useMostCommon = false } = {}
) => {
    const json = parseYarnLock(yarnLock);
    const packages = extractPackages(json, includePackages, excludePackages);
    const result = [];

    getDuplicatedPackages(packages, { useMostCommon }).forEach(
        ({ bestVersion, name, installedVersion, requestedVersions }) => {
            result.push(
                `Package "${name}" wants ${requestedVersions.join(
                    ','
                )} and could get ${bestVersion}, but got ${installedVersion}`
            );
        }
    );

    return result;
};

module.exports.fixDuplicates = (
    yarnLock,
    { includePackages = [], excludePackages = [], useMostCommon = false } = {}
) => {
    const json = parseYarnLock(yarnLock);
    const packages = extractPackages(json, includePackages, excludePackages);
    const changesToPackages = new Map();

    getDuplicatedPackages(packages, { useMostCommon }).forEach(
        ({ name, bestVersion, installedVersion }) => {
            if (!changesToPackages.has(name)) {
                changesToPackages.set(name, []);
            }

            changesToPackages.get(name).push({ bestVersion, installedVersion });
        }
    );

    changesToPackages.forEach((changes, name) => {
        const entries = new Map(
            packages[name].map(({ installedVersion, key, pkg }) => [
                installedVersion,
                { key, pkg, deleted: false, changed: false },
            ])
        );

        changes.forEach(({ bestVersion, installedVersion }) => {
            const entry = entries.get(bestVersion);

            const installedVersionEntry = entries.get(installedVersion);
            if (
                installedVersionEntry.changed &&
                installedVersionEntry.newKey.startsWith(installedVersionEntry.key)
            ) {
                installedVersionEntry.newKey = installedVersionEntry.newKey.slice(
                    installedVersionEntry.key.length + ', '.length
                );
            } else {
                installedVersionEntry.deleted = true;
            }

            if (entry.deleted) throw new Error('Unsupported');
            entry.newKey = (entry.newKey || entry.key) + ', ' + entries.get(installedVersion).key;
            entry.changed = true;
        });

        entries.forEach(({ key, newKey, pkg, deleted, changed }) => {
            if (deleted || changed) {
                delete json[key];

                if (changed) {
                    const newKeyRequested = newKey.split(', ');
                    newKeyRequested.sort((versionA, versionB) => {
                        return semver.compare(
                            semver.minVersion(versionA.split(':', 2)[1]),
                            semver.minVersion(versionB.split(':', 2)[1])
                        );
                    });
                    json[newKeyRequested.join(', ')] = pkg;
                }
            }
        });
    });

    return yarnParsers.stringifySyml(json);
};
