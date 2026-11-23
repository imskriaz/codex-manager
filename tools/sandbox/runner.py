"""One bounded job, inside the disposable container. Never run this on the host."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

job = json.loads(sys.stdin.read(12 * 1024 * 1024 + 1))
root = Path('/work')
for item in job['files']:
    file = root / item['path']
    if not file.is_relative_to(root) or any(part.startswith('.') or part == '..' for part in Path(item['path']).parts):
        raise ValueError('Invalid file')
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(base64.b64decode(item['data'], validate=True))
programs = {'python': ('python3', 'script.py'), 'node': ('node', 'script.cjs'), 'php': ('php', 'script.php')}
executable, script = programs[job['language']]
script_path = Path('/tmp') / script
script_path.write_text(job['code'], encoding='utf-8')
output = root / 'output'
output.mkdir(exist_ok=True)
status, stdout, stderr = 'failed', '', ''
try:
    result = subprocess.run([executable, str(script_path)], cwd=root, capture_output=True, timeout=55,
                            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'WORKSPACE_OUTPUT': str(output)})
    stdout, stderr = result.stdout.decode('utf-8', 'replace')[:32000], result.stderr.decode('utf-8', 'replace')[:32000]
    status = 'completed' if result.returncode == 0 else 'failed'
except subprocess.TimeoutExpired:
    status, stderr = 'timeout', 'Execution exceeded 55 seconds.'
files, size = [], 0
if status == 'completed':
    for file in output.rglob('*'):
        if file.is_symlink() or not file.is_file():
            continue
        resolved = file.resolve()
        if not resolved.is_relative_to(output) or os.stat(file).st_nlink > 1:
            raise ValueError('Linked output file')
        length = file.stat().st_size
        size += length
        if len(files) >= 30 or length > 2 * 1024 * 1024 or size > 8 * 1024 * 1024:
            status, stderr, files = 'failed', 'Output file limit exceeded.', []
            break
        files.append({'path': str(file.relative_to(output)), 'data': base64.b64encode(file.read_bytes()).decode()})
print(json.dumps({'status': status, 'stdout': stdout, 'stderr': stderr, 'files': files}))
