const { fixDuplicates, listDuplicates } = require('../index.js');
const yarnParsers = require('@yarnpkg/parsers');
const outdent = require('outdent');

test('dedupes lockfile to max compatible version', () => {
    const yarn_lock = outdent`
    "library@npm:^1.1.0, library@npm:^1.2.0":
      version: "1.2.0"
      resolution: "library@npm:1.2.0"
      linkType: hard

    "library@npm:^1.3.0":
      version: "1.3.0"
      resolution: "library@npm:1.3.0"
      linkType: hard
    `;
    const deduped = fixDuplicates(yarn_lock);
    const json = yarnParsers.parseSyml(deduped);

    expect(json['library@npm:^1.1.0, library@npm:^1.2.0, library@npm:^1.3.0']['version']).toEqual(
        '1.3.0'
    );

    const list = listDuplicates(yarn_lock);

    expect(list).toContain(
        'Package "library" wants ^1.1.0,^1.2.0 and could get 1.3.0, but got 1.2.0'
    );
});

test('dedupes lockfile to max compatible version with ~', () => {
    const yarn_lock = outdent`
  "library@npm:~1.1.0":
    version: "1.1.0"
    resolution: "library@npm:1.1.0"
    linkType: hard

  "library@npm:^1.1.1":
    version: "1.1.1"
    resolution: "library@npm:1.1.1"
    linkType: hard

  "library@npm:^1.3.0":
    version: "1.3.0"
    resolution: "library@npm:1.3.0"
    linkType: hard
  `;
    const deduped = fixDuplicates(yarn_lock);
    const json = yarnParsers.parseSyml(deduped);

    expect(Object.keys(json).length).toBe(2);
    expect(json['library@npm:~1.1.0']['version']).toEqual('1.1.1');
    expect(json['library@npm:^1.1.1, library@npm:^1.3.0']['version']).toEqual('1.3.0');

    const list = listDuplicates(yarn_lock);

    expect(list).toContain('Package "library" wants ~1.1.0 and could get 1.1.1, but got 1.1.0');
    expect(list).toContain('Package "library" wants ^1.1.1 and could get 1.3.0, but got 1.1.1');
});

test('dedupes lockfile to most common compatible version', () => {
    const yarn_lock = outdent`
    "library@npm:>=1.0.0, library@npm:>=1.1.0":
      version: "3.0.0"
      resolution: "library@npm:3.0.0"
      linkType: hard

    "library@npm:^2.0.0":
      version: "2.1.0"
      resolution: "library@npm:2.1.0"
      linkType: hard
  `;
    const deduped = fixDuplicates(yarn_lock, {
        useMostCommon: true,
    });
    const json = yarnParsers.parseSyml(deduped);

    expect(json['library@npm:>=1.0.0, library@npm:>=1.1.0, library@npm:^2.0.0']['version']).toEqual(
        '2.1.0'
    );

    const list = listDuplicates(yarn_lock, {
        useMostCommon: true,
    });

    expect(list).toContain(
        'Package "library" wants >=1.0.0,>=1.1.0 and could get 2.1.0, but got 3.0.0'
    );
});

test('limits the packages to be de-duplicated', () => {
    const yarn_lock = outdent`
    "a-package@npm:^2.0.0":
      version: "2.0.0"
      resolution: "a-package@npm:2.0.0"
      linkType: hard

    "a-package@npm:^2.0.1":
      version: "2.0.1"
      resolution: "a-package@npm:2.0.1"
      linkType: hard

    "other-package@npm:^1.0.0":
      version: "1.0.11"
      resolution: "other-package@npm:1.0.11"
      linkType: hard

    "other-package@npm:^1.0.1":
      version: "1.0.12"
      resolution: "other-package@npm:1.0.12"
      linkType: hard
  `;

    const deduped = fixDuplicates(yarn_lock, {
        includePackages: ['other-package'],
    });
    const json = yarnParsers.parseSyml(deduped);

    expect(json['a-package@npm:^2.0.0']['version']).toEqual('2.0.0');
    expect(json['a-package@npm:^2.0.1']['version']).toEqual('2.0.1');
    expect(json['other-package@npm:^1.0.0, other-package@npm:^1.0.1']['version']).toEqual('1.0.12');

    const list = listDuplicates(yarn_lock, {
        includePackages: ['other-package'],
    });

    expect(list).toHaveLength(1);
    expect(list).toContain(
        'Package "other-package" wants ^1.0.0 and could get 1.0.12, but got 1.0.11'
    );
});

test('excludes packages to be de-duplicated', () => {
    const yarn_lock = outdent`
    "a-package@npm:^2.0.0":
      version: "2.0.0"
      resolution: "a-package@npm:2.1.0"
      linkType: hard

    "a-package@npm:^2.0.1":
      version: "2.0.1"
      resolution: "a-package@npm:2.2.0"
      linkType: hard

    "other-package@npm:^1.0.0":
      version: "1.0.11"
      resolution: "other-package@npm:1.0.11"
      linkType: hard

    "other-package@npm:^1.0.1":
      version: "1.0.12"
      resolution: "other-package@npm:1.0.12"
      linkType: hard
  `;

    const deduped = fixDuplicates(yarn_lock, {
        excludePackages: ['a-package'],
    });
    const json = yarnParsers.parseSyml(deduped);

    expect(json['a-package@npm:^2.0.0']['version']).toEqual('2.0.0');
    expect(json['a-package@npm:^2.0.1']['version']).toEqual('2.0.1');
    expect(json['other-package@npm:^1.0.0, other-package@npm:^1.0.1']['version']).toEqual('1.0.12');

    const list = listDuplicates(yarn_lock, {
        excludePackages: ['a-package'],
    });

    expect(list).toHaveLength(1);
    expect(list).toContain(
        'Package "other-package" wants ^1.0.0 and could get 1.0.12, but got 1.0.11'
    );
});

test('should support the integrity field if present', () => {
    const yarn_lock = outdent({ trimTrailingNewline: false })`
    __metadata:
      version: 4

    "a-package@npm:^2.0.0":
      version: 2.0.1
      resolution: "library@npm:2.0.1"
      dependencies:
        a-second-package: ^2.0.0
      integrity: sha512-ptqFDzemkXGMf7ylch/bCV+XTDvVjD9dRymzcjOPIxg8Hqt/uesOye10GXItFbsxJx9VZeJBYrR8FFTauu+hHg==
      linkType: hard

    "a-second-package@npm:^2.0.0":
      version: 2.0.1
      resolution: "a-second-package@npm:2.0.1"
      integrity: sha512-ptqFDzemkXGMf7ylch/bCV+XTDvVjD9dRymzcjOPIxg8Hqt/uesOye10GXItFbsxJx9VZeJBYrR8FFTauu+hHg==
      linkType: hard
  `;

    const deduped = fixDuplicates(yarn_lock);

    // We should not have made any change to the order of outputted lines (@yarnpkg/lockfile 1.0.0 had this bug)
    expect(yarn_lock).toBe(deduped);
});
