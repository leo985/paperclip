"""Managed personal CLI; domain commands continue to use the enrolled Harness."""
import subprocess
import sys
from pathlib import Path
# Installer probe checks the real cmd -> Python -> bridge path without loading
# credentials, contacting the server, or requiring first enrollment to finish.
if sys.argv[1:] == ['--verify-seat-launcher']:
    print('PAPERCLIP_SEAT_LAUNCHER_OK')
    raise SystemExit(0)
from seat_profiles import route_cli
try:sys.argv=[sys.argv[0],*route_cli(sys.argv[1:])]
except (RuntimeError,OSError,ValueError) as e:
    print(str(e),file=sys.stderr);sys.exit(2)
from pilot import DEFAULT_CONFIG,read_json,BridgeError
if sys.argv[1:2] and (sys.argv[1] in {'online','offline','upgrade','service'} or sys.argv[1]=='doctor' and not any(x in sys.argv[2:] for x in ('--environment','--repo','-C','--clean-lastupdated'))):
    from seat_lifecycle import main
    main(sys.argv[1:])
elif sys.argv[1:2]==['capability']:
    from harness_capabilities import main
    try:main(sys.argv[2:])
    except (BridgeError,OSError,ValueError) as e:
        print('Harness 能力登记失败：'+str(e),file=sys.stderr);sys.exit(2)
elif sys.argv[1:2]==['phase']:
    sys.argv=[sys.argv[0],*sys.argv[2:]]
    if sys.argv[1:2]==['check']:sys.argv.pop(1)
    from phase_gate import main
    raise SystemExit(main())
elif sys.argv[1:2] and sys.argv[1] in {'start','attach','stop','status','knowledge','seat','repo'}:
    from interactive import main
    try:main()
    except (BridgeError,OSError,ValueError) as e:
        print('交互接入失败：'+str(e),file=sys.stderr);sys.exit(2)
else:
    if not sys.argv[1:] or sys.argv[1:] in (['--help'],['-h']):print('席位命令：harness online 上线 / harness offline 安全下线 / harness doctor 诊断 / harness upgrade 更新 / harness service install 补装登录后自动上线服务',flush=True)
    root=Path(read_json(DEFAULT_CONFIG)['harness_root'])
    if sys.argv[1:3]==['doctor','--environment']:
        sys.path.insert(0,str(root/'harness/scripts'))
        from harness_cli import cmd_doctor
        raise SystemExit(cmd_doctor(sys.argv[3:]))
    raise SystemExit(subprocess.call([sys.executable,str(root/'harness/scripts/harness_cli.py'),*sys.argv[1:]]))
