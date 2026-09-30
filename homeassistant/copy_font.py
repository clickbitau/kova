import os
import shutil

src = '/root/MonumentValley12-X55o.otf'
dst_dir = '/opt/homeassistant/www/fonts'
dst = os.path.join(dst_dir, 'MonumentValley12.otf')

os.makedirs(dst_dir, exist_ok=True)
if os.path.exists(src):
    shutil.copy2(src, dst)
    print(f"Copied {src} to {dst}")
    os.chmod(dst, 0o644)
else:
    print(f"File not found: {src}")
