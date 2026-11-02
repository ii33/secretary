const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const profile = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');
const config = path.join(profile, 'package.json');
const bundle = path.resolve(__dirname, '..', 'dsh-office-local').replaceAll('\\', '/');
const data = JSON.parse(fs.readFileSync(config, 'utf8'));
const backup = config + '.bak-office-' + Date.now();
fs.copyFileSync(config, backup);
data.dependencies ||= {};
data.dependencies['@local/dsh-office'] = 'link:' + bundle;
data.dsh ||= {}; data.dsh.profile ||= {}; data.dsh.profile.bundles ||= [];
if (!data.dsh.profile.bundles.includes('@local/dsh-office')) data.dsh.profile.bundles.push('@local/dsh-office');
try {
  fs.writeFileSync(config, JSON.stringify(data, null, 2) + '\n');
  const scope = path.join(profile, 'node_modules', '@local');
  fs.mkdirSync(scope, {recursive:true});
  const link = path.join(scope, 'dsh-office');
  if (fs.existsSync(link)) {
    if (fs.realpathSync(link).toLowerCase() !== fs.realpathSync(bundle).toLowerCase()) throw Error('An existing dsh-office installation points elsewhere: ' + link);
  } else fs.symlinkSync(bundle, link, 'junction');
  console.log('Installed secretary-office. Restart DSH. Backup: ' + backup);
} catch (error) {
  fs.copyFileSync(backup, config);
  throw error;
}
