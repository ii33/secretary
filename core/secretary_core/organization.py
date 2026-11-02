"""Project-scoped organization, mailbox and round persistence."""
import json
from . import db


def setup(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS organization(project TEXT PRIMARY KEY, mode TEXT NOT NULL, members TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS member_message(id TEXT PRIMARY KEY, project TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE INDEX IF NOT EXISTS member_inbox ON member_message(project,recipient,read_at);
    CREATE TABLE IF NOT EXISTS project_round(id TEXT PRIMARY KEY, project TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL, assignments TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(project,number));
    CREATE TABLE IF NOT EXISTS round_activation(round_id TEXT NOT NULL, project TEXT NOT NULL, member TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(round_id,member));
    ''')


def config(conn, project):
    row = conn.execute('SELECT * FROM organization WHERE project=?',(project,)).fetchone()
    return dict(project=project, mode=row['mode'] if row else 'tree', members=json.loads(row['members']) if row else [], revision=row['revision'] if row else 0)


def configure(conn, project, mode, members):
    if mode not in ('tree','flat'):
        raise ValueError('unknown architecture')
    if mode == 'flat' and members:
        if sum(m.get('role') == 'main' for m in members) != 1:
            raise ValueError('flat architecture requires exactly one main member')
        ids = [m.get('id') for m in members]
        sessions = [m.get('session_id') for m in members]
        if not all(isinstance(x,str) and x.strip() for x in ids+sessions) or len(set(ids)) != len(ids) or len(set(sessions)) != len(sessions):
            raise ValueError('member and session identities must be nonempty and unique')
        if any(m.get('role') not in ('main','child') or not m.get('preset') for m in members):
            raise ValueError('each member requires a role and preset')
    if conn.execute("SELECT 1 FROM project_round WHERE project=? AND status='running'",(project,)).fetchone():
        raise ValueError('finish the active round before changing architecture')
    conn.execute('INSERT INTO organization(project,mode,members) VALUES (?,?,?) ON CONFLICT(project) DO UPDATE SET mode=excluded.mode,members=excluded.members,revision=organization.revision+1',(project,mode,json.dumps(members)))
    conn.commit()
    return config(conn,project)


def member(conn, project, session):
    return next((m for m in config(conn,project)['members'] if m['session_id']==session),None)


def require_flat(conn, project):
    if config(conn, project)["mode"] != "flat":
        raise ValueError("messaging is available only in flat architecture")


def send(conn, project, session, recipient, text):
    require_flat(conn, project)
    sender = member(conn,project,session)
    if not sender or recipient not in [m['id'] for m in config(conn,project)['members']]:
        raise ValueError('sender and recipient must belong to this project')
    if not isinstance(text,str) or not text.strip() or len(text)>12000:
        raise ValueError('message must contain 1 to 12000 characters')
    ident = db.new_id('M')
    conn.execute('INSERT INTO member_message VALUES (?,?,?,?,?,?,NULL)',(ident,project,sender['id'],recipient,text,db.now_ms()))
    conn.commit()
    return {'id':ident}


def inbox(conn,project,session,unread=True,mark_read=False):
    require_flat(conn, project)
    owner = member(conn,project,session)
    if not owner:
        raise ValueError('session is not a project member')
    rows = conn.execute('SELECT * FROM member_message WHERE project=? AND recipient=?'+(' AND read_at IS NULL' if unread else '')+' ORDER BY created_at,id LIMIT 100',(project,owner['id'])).fetchall()
    if mark_read:
        conn.executemany('UPDATE member_message SET read_at=? WHERE id=? AND project=? AND recipient=?',[(db.now_ms(),r['id'],project,owner['id']) for r in rows])
        conn.commit()
    return [dict(r) for r in rows]


def start_round(conn,project,session,assignments):
    cfg = config(conn,project)
    owner = member(conn,project,session)
    if cfg['mode']!='flat' or not owner or owner['role']!='main':
        raise ValueError('only the main member can start a flat round')
    if conn.execute("SELECT 1 FROM project_round WHERE project=? AND status='running'",(project,)).fetchone():
        raise ValueError('a round is already running')
    children = {m['id']:m for m in cfg['members'] if m['role']=='child'}
    if not isinstance(assignments,dict) or any(k not in children or not isinstance(v,str) or not v.strip() for k,v in assignments.items()):
        raise ValueError('assign tasks only to child members in this project')
    number = conn.execute('SELECT COALESCE(MAX(number),0)+1 FROM project_round WHERE project=?',(project,)).fetchone()[0]
    ident = db.new_id('R')
    conn.execute("INSERT INTO project_round VALUES (?,?,?,'running',?,?)",(ident,project,number,json.dumps(assignments),db.now_ms()))
    for child in children:
        if child in assignments or conn.execute('SELECT 1 FROM member_message WHERE project=? AND recipient=? AND read_at IS NULL',(project,child)).fetchone():
            conn.execute('INSERT INTO round_activation(round_id,project,member,task) VALUES (?,?,?,?)',(ident,project,child,assignments.get(child,'')))
    if not conn.execute('SELECT 1 FROM round_activation WHERE round_id=?',(ident,)).fetchone():
        conn.execute("UPDATE project_round SET status='completed' WHERE id=?",(ident,))
    conn.commit()
    return {'id':ident,'number':number,'activations':[dict(r) for r in conn.execute('SELECT * FROM round_activation WHERE round_id=?',(ident,))]}

def rounds(conn, project):
    rows = conn.execute('SELECT * FROM project_round WHERE project=? ORDER BY number DESC LIMIT 20',(project,)).fetchall()
    return [dict(r, activations=[dict(a) for a in conn.execute('SELECT * FROM round_activation WHERE round_id=?',(r['id'],))]) for r in rows]


def pending(conn):
    return [dict(r) for r in conn.execute("SELECT a.*, r.number FROM round_activation a JOIN project_round r ON r.id=a.round_id WHERE r.status='running' AND a.status='pending'")]


def activation_status(conn, project, round_id, ident, status, error=None):
    if status not in ('dispatched','failed','done'):
        raise ValueError('invalid activation status')
    conn.execute('UPDATE round_activation SET status=?,error=? WHERE project=? AND round_id=? AND member=?',(status,error,project,round_id,ident))
    if not conn.execute("SELECT 1 FROM round_activation WHERE round_id=? AND status IN ('pending','dispatched')",(round_id,)).fetchone():
        cfg = config(conn,project)
        main = next((m for m in cfg['members'] if m['role']=='main'), None)
        if main and ident != main['id'] and not conn.execute('SELECT 1 FROM round_activation WHERE round_id=? AND member=?',(round_id,main['id'])).fetchone():
            conn.execute('INSERT INTO round_activation(round_id,project,member,task) VALUES (?,?,?,?)',(round_id,project,main['id'],'本轮子代理已结束。检查执行结果与失败状态，验收并决定下一轮委派。'))
        else:
            conn.execute("UPDATE project_round SET status='completed' WHERE id=? AND project=?",(round_id,project))
    conn.commit()
    return {'status':status}


def complete_session(conn,project,session):
    if config(conn, project)["mode"] != "flat":
        return
    actor = member(conn,project,session)
    if actor:
        for row in conn.execute("SELECT round_id FROM round_activation WHERE project=? AND member=? AND status='dispatched'",(project,actor['id'])).fetchall():
            activation_status(conn,project,row['round_id'],actor['id'],'done')


def sync_members(conn, project, members):
    cfg = config(conn, project)
    if cfg['mode'] != 'flat':
        raise ValueError('automatic flat membership requires flat architecture')
    active = conn.execute("SELECT 1 FROM project_round WHERE project=? AND status='running'", (project,)).fetchone()
    if active:
        return cfg
    if cfg['members'] == members:
        return cfg
    return configure(conn, project, 'flat', members)
