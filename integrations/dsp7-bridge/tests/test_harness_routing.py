from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from harness_routing import resolve_route, assert_legacy_development_root
from pilot import BridgeError

class HarnessRoutingTest(unittest.TestCase):
    def test_route_is_machine_domain_and_version_bound(self):
        b=SimpleNamespace(cfg={'agent_id':'seat','company_id':'company'},root=Path('/original'))
        capability={'kind':'analysis','root':'/analysis','profile':'dsp','commit':'head'}
        item={**capability,'id':'cap'};registry={'version':1,'revision':2,'items':[item]}
        route={'protocolVersion':1,'runId':'run','taskId':'task','agentId':'seat','companyId':'company','machineId':'machine','registryRevision':2,'capabilityId':'cap','capability':capability}
        b.cfg['harness_capabilities']=registry
        api=Mock();api.request.return_value=registry
        with patch('harness_routing.identity',return_value={'machine_id':'machine'}),patch('harness_routing.seat_api',return_value=api),patch('harness_routing.inspect',return_value=capability):
            self.assertEqual(resolve_route(b,route,'run','task','analysis'),capability)
            for changed in [{'machineId':'other'},{'registryRevision':3},{'capabilityId':'other'},{'capability':{**capability,'commit':'changed'}}]:
                with self.assertRaises(BridgeError):resolve_route(b,{**route,**changed},'run','task','analysis')
            with self.assertRaises(BridgeError):resolve_route(b,route,'run','task','qa')

    def test_missing_new_domain_route_and_legacy_root_switch_never_fall_back(self):
        b=SimpleNamespace(root=Path('/original'))
        self.assertIsNone(resolve_route(b,None,'run','task','development'))
        with self.assertRaises(BridgeError):resolve_route(b,None,'run','task','analysis')
        with self.assertRaises(BridgeError):assert_legacy_development_root(b,{'root':'/other'})
