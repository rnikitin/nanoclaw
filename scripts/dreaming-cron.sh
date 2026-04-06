#!/bin/bash
# Dreaming cron runner — runs memory consolidation for all groups
PHASE=${1:-all}
cd /root/nanoclaw

node -e "
const { readdirSync, existsSync } = require('fs');
const { join } = require('path');
const groupsDir = './groups';
const phase = '${PHASE}';

// Dynamic import for ESM
(async () => {
  const { lightSleep, remSleep, deepSleep, dreamCycle, setupGroupDreaming } = await import('./dist/memory/dreaming.js');
  
  for (const dir of readdirSync(groupsDir)) {
    const groupDir = join(groupsDir, dir);
    if (!existsSync(join(groupDir, 'memory'))) continue;
    
    // Ensure dreaming is set up
    setupGroupDreaming(groupDir);
    
    console.log(\`[\${new Date().toISOString()}] Dreaming \${phase} for \${dir}\`);
    try {
      if (phase === 'light') {
        const r = lightSleep(groupDir);
        console.log(\`  Light: \${r.candidates} candidates, \${r.deduplicated} deduped\`);
      } else if (phase === 'rem') {
        const r = remSleep(groupDir);
        console.log(\`  REM: \${r.patterns} patterns\`);
      } else if (phase === 'deep') {
        const r = deepSleep(groupDir);
        console.log(\`  Deep: \${r.promoted} promoted, \${r.rejected} rejected\`);
      } else {
        const r = dreamCycle(groupDir);
        console.log(\`  Light: \${r.light.candidates} → \${r.light.deduplicated}\`);
        console.log(\`  REM: \${r.rem.patterns} patterns\`);
        console.log(\`  Deep: \${r.deep.promoted} promoted\`);
      }
    } catch (e) {
      console.error(\`  Error: \${e.message}\`);
    }
  }
})();
"
