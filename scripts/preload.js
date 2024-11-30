const path = require('path');
const fs = require('fs-extra');

const srcDir = path.join(__dirname, '../configs-load');
const destDir = path.join(__dirname, '../configs');

if (fs.pathExistsSync(srcDir)) {
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copySync(path.join(srcDir, file), path.join(destDir, file));
    console.log(`Copied ${path.join(srcDir, file)} -> ${path.join(destDir, file)}`);
  }
}
