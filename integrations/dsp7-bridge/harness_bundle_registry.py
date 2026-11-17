"""Explicit candidate discovery registration; never changes execution routing."""
from harness_bundle import validate


def descriptor(config):
    checked=validate(config)
    return dict(protocolVersion=1,bundleDigest=config['bundleDigest'],project=config['project'],mode='candidate',
        packages=[dict(id=p['id'],version=p['version'],layer=p['layer'],skills=p['skills'],
            manifestDigest=checked['sourceDigest'] if p['layer']=='L3' else checked['resourceDigest'])
            for p in checked['catalog']['packages']])


def register(bridge, config=None):
    from seats import seat_api,identity
    # Validate before networking. No absolute paths or source maps are exported.
    bundle=descriptor(config if config is not None else bridge.cfg.get('harness_v2_observation',{}))
    api=seat_api(bridge);endpoint='/agents/'+bridge.cfg['agent_id']+'/dsp7-harness-bundles'
    current=api.request('GET',endpoint)
    if current.get('registrationSupported') is not True:
        return {'registered':False,'reason':'BUNDLE_REGISTRATION_UNSUPPORTED'}
    # CAS conflicts surface to the caller; never silently retry against a newer registry.
    return api.request('POST',endpoint,{**identity(bridge),'expectedRevision':current['revision'],'bundle':bundle})
