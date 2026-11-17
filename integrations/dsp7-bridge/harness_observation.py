"""Private Harness summary -> existing transactional Collector outbox.

Caller supplies a summary from the validated Harness query boundary. No file path,
network client, launcher, permit or business timing authority is introduced here.
"""
import hashlib
import json
import re
import uuid

CAPABILITY = 'harness.observation/1'
KEYS = set('schema runId companyId taskId streamId sourceDigest resourceDigest observedEvents droppedEvents observedSessionEnd pendingObservedCalls hostSessionConfirmed processExitConfirmed platformAccepted durationMinutes'.split())


def validate_summary(value, expected):
    if not isinstance(value, dict) or set(value) != KEYS:
        raise ValueError('Invalid Harness summary shape')
    if value['schema'] != 'harness.v2.observation-summary/1':
        raise ValueError('Invalid Harness summary version')
    for key in ('runId', 'companyId', 'taskId'):
        if not isinstance(value[key], str) or str(uuid.UUID(value[key])) != value[key] or value[key] != expected[key]:
            raise ValueError('Harness scope mismatch')
    if not isinstance(value['streamId'], str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', value['streamId']):
        raise ValueError('Invalid Harness stream')
    for key in ('sourceDigest', 'resourceDigest'):
        if not isinstance(value[key], str) or not re.fullmatch('[a-f0-9]{64}', value[key]):
            raise ValueError('Invalid Harness digest')
    for key in ('observedEvents', 'droppedEvents', 'pendingObservedCalls'):
        if type(value[key]) is not int or not 0 <= value[key] <= 9007199254740991:
            raise ValueError('Invalid Harness count')
    if not 1 <= value['observedEvents'] <= 512 or value['pendingObservedCalls'] > value['observedEvents'] or (value['droppedEvents'] and value['observedEvents'] != 512):
        raise ValueError('Invalid Harness coverage')
    if type(value['observedSessionEnd']) is not bool or any(value[k] is not False for k in ('hostSessionConfirmed', 'processExitConfirmed', 'platformAccepted')) or value['durationMinutes'] is not None:
        raise ValueError('Invalid Harness authority claim')
    return json.loads(json.dumps(value))


def enqueue_summary(collector, summary):
    """Atomic cursor + outbox append; serialized across Collector instances."""
    value = validate_summary(summary, {'runId': collector.run_id, 'companyId': collector.cfg['company_id'], 'taskId': collector.row()['task_id']})
    stream = 'harness:' + value['streamId']
    key = 'harness-observation:' + value['streamId']
    fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if collector.db.in_transaction:
        raise ValueError('Harness enqueue requires its own transaction')
    try:
        collector.db.execute('BEGIN IMMEDIATE')
        row = collector.row()
        if row['collection_paused'] or row['finalized']:
            collector.db.rollback()
            return 'paused'
        previous = collector.meta(key)
        if previous:
            if previous['digest'] == fingerprint:
                collector.db.rollback()
                return 'duplicate'
            old = previous['summary']
            if any(old[k] != value[k] for k in ('sourceDigest', 'resourceDigest')) or value['observedEvents'] < old['observedEvents'] or value['droppedEvents'] < old['droppedEvents'] or (old['observedSessionEnd'] and not value['observedSessionEnd']):
                raise ValueError('Harness stream regression or version change')
            if value['observedEvents'] + value['droppedEvents'] == old['observedEvents'] + old['droppedEvents']:
                raise ValueError('Conflicting Harness snapshot')
        collector.queued_bytes = collector.queue_size()
        collector.event(stream, 'harness.observation', value, generation=CAPABILITY)
        collector.setmeta(key, {'digest': fingerprint, 'summary': value})
        collector.db.commit()
        return 'queued'
    except BaseException:
        collector.db.rollback()
        raise
    finally:
        collector.queued_bytes = collector.queue_size()


if __name__ == '__main__':
    import argparse
    import sys
    from pathlib import Path
    from managed_sessions import Collector
    parser = argparse.ArgumentParser(description='Queue a validated Harness summary; no upload')
    parser.add_argument('--config', required=True)
    parser.add_argument('--run', required=True)
    args = parser.parse_args()
    collector = None
    try:
        raw = sys.stdin.read(16385)
        if len(raw) > 16384:
            raise ValueError('Summary too large')
        cfg = json.loads(Path(args.config).read_text())
        collector = Collector(cfg, args.run)
        print(json.dumps({'status': enqueue_summary(collector, json.loads(raw))}))
    except Exception:
        print('Harness observation rejected; queue unchanged.', file=sys.stderr)
        sys.exit(1)
    finally:
        if collector:
            collector.db.close()
