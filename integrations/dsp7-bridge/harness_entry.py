"""Windows command shim; domain commands continue to use the enrolled Harness."""
import subprocess
import sys
from pathlib import Path
from pilot import DEFAULT_CONFIG,read_json
if sys.argv[1:2] and sys.argv[1] in {'start','attach','status','knowledge','seat','repo'}:
    from interactive import main
    main()
else:
    root=Path(read_json(DEFAULT_CONFIG)['harness_root'])
    raise SystemExit(subprocess.call([sys.executable,str(root/'harness/scripts/harness_cli.py'),*sys.argv[1:]]))
