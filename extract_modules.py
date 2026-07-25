import os, re

modules = set()
for root, dirs, files in os.walk('src'):
    for f in files:
        if f.endswith('.ts'):
            fp = os.path.join(root, f)
            with open(fp, 'r', encoding='utf-8') as fh:
                for line in fh:
                    if line.startswith('import '):
                        m = re.search(r'"([^"]+)"', line)
                        if m:
                            mod = m.group(1)
                            if not mod.startswith('.'):
                                modules.add(mod)

result = ','.join(sorted(modules))
print(result, end='')
