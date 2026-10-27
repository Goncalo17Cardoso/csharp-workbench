// Generates the .nupkg fixtures under test/fixtures/local. Run: npx tsx test/fixtures/make-local-feed.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const root = join(__dirname, 'local');

function nuspec(id: string, version: string, description: string, deps: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${id}</id>
    <version>${version}</version>
    <authors>Acme</authors>
    <description>${description}</description>
    <projectUrl>https://example.com/${id}</projectUrl>
    <license type="expression">MIT</license>
${deps}
  </metadata>
</package>`;
}

function write(path: string, id: string, version: string, description: string, deps = ''): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  const files = { [`${id}.nuspec`]: strToU8(nuspec(id, version, description, deps)), 'lib/net8.0/_._': new Uint8Array() };
  writeFileSync(full, zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') }));
}

write('flat/Foo.1.0.0.nupkg', 'Foo', '1.0.0', 'A Handy Utility library', `    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Bar" version="[1.10.0, )" />
      </group>
      <group targetFramework=".NETStandard2.0" />
    </dependencies>`);
write('flat/Foo.1.10.0.nupkg', 'Foo', '1.10.0', 'A Handy Utility library');
write('hier/foo/2.0.0/foo.2.0.0.nupkg', 'foo', '2.0.0', 'Hierarchical layout package');
