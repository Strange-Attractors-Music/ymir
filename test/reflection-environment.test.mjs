import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('inspection materials sample a continuous studio cubemap by reflection direction',async()=>{
  const shader=await readFile(new URL('materials/ymir-surfaces-v1/main.frag',root),'utf8');
  const environment=await readFile(new URL('effects/grwm-v4/mirror_environment.js',root),'utf8');

  assert.match(shader,/uniform float studio_environment/);
  assert.match(shader,/if\(studio_environment>\.5\)\{\s*vec3 encoded=textureLod\(environment_map,normalize\(direction\)/);
  assert.match(shader,/vec3 distances=\(wall-world_pos\)\/safeRay/,'GRWM box projection remains isolated to its non-studio path');
  assert.match(environment,/uniform float probe_pass,linear_background,studio_pass/);
  assert.match(environment,/if\(studio_pass>\.5\)\{[\s\S]*?vec3 c=studio\(ray\);[\s\S]*?return;/);
  assert.match(environment,/vec3 studio\(vec3 ray\)/);
  assert.match(environment,/options\.studio\?1:0/);
});

test('installer refreshes shader assets without replacing an existing catalog',async()=>{
  const installer=await readFile(new URL('install.sh',root),'utf8');
  const catalogCheck=installer.indexOf('if [[ -f "${DATA_DIR}/catalog.json" ]]');
  const syncLoop=installer.indexOf('for item in materials colors effects; do');
  assert.ok(catalogCheck>=0);
  assert.ok(syncLoop>catalogCheck,'shader asset sync follows the existing-catalog preservation check');
  assert.match(installer,/cp -r "\$\{SOURCE_DIR\}\/\$\{item\}\/\." "\$\{DATA_DIR\}\/\$\{item\}\/"/);
  assert.match(installer,/TRINITY_SOURCE_DIR="\$\{SOURCE_DIR\}\/\.\.\/trinity"/);
  assert.match(installer,/cp "\$\{TRINITY_BUNDLE\}" "\$\{LIB_DIR\}\/node_modules\/trinity\/dist\/"/);
});
