import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from secretary_core import db, compress, organization
from secretary_core.server import CoreServer

class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = CoreServer(self.tmp.name)
        self.conn = self.server.conn
        self.handler = object.__new__(self.server._make_handler())
    def tearDown(self):
        self.conn.close()
        for handler in self.server.logger.handlers[:]:
            handler.close()
            self.server.logger.removeHandler(handler)
        self.tmp.cleanup()
    def event(self, project, seq):
        return db.insert_turn(self.conn, dict(project=project, external_session=project, external_seq=seq, payload=dict(role='secretary', user_text='deployment', assistant_text='deployment')))
    def test_search_candidates_are_project_scoped(self):
        for i in range(65):
            self.event('other', i)
        self.event('mine', 100)
        self.assertTrue(db.search(self.conn, 'mine', 'deployment'))
        for i in range(40):
            db.add_note(self.conn, 'other', 'fact', 'deployment')
        db.add_note(self.conn, 'mine', 'fact', 'deployment')
        self.assertTrue(db.search_notes(self.conn, 'mine', 'deployment'))
    def test_ids_and_deleted_turns(self):
        note = db.add_note(self.conn, 'other', 'fact', 'secret')
        self.assertEqual(self.handler._dispatch('GET', '/v1/get/'+note['id'], {'project':'mine'}, {})[0], 404)
        task = db.add_task(self.conn, 'other', 'current', 'secret')
        self.assertEqual(self.handler._dispatch('POST', '/v1/taskboard', {}, {'project':'mine','id':task['id'],'remove':True})[0],404)
        self.event('mine', 1)
        turn = self.conn.execute("SELECT id FROM turns WHERE project='mine'").fetchone()[0]
        db.recycle_turn(self.conn,'mine',turn)
        self.assertEqual(self.handler._dispatch('GET','/v1/get/'+str(turn),{'project':'mine'}, {})[0],404)
    def test_advice_accept_is_idempotent(self):
        advice = db.add_advice(self.conn,'mine','deployment','deployment')
        db.set_advice_status(self.conn,advice['id'],'accepted')
        db.set_advice_status(self.conn,advice['id'],'accepted')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM turns WHERE project='mine'").fetchone()[0],1)
        self.assertTrue(db.search_turns(self.conn,'mine','deployment'))

    def test_purge_removes_derived_memory(self):
        self.event('mine', 1)
        turn = self.conn.execute("SELECT id FROM turns WHERE project='mine'").fetchone()[0]
        note = db.add_note(self.conn,'mine','fact','deployment',turn)
        self.conn.execute("INSERT INTO summaries(id,project,content) VALUES ('S-test','mine','secret')")
        self.conn.execute("UPDATE turns SET summary_id='S-test' WHERE id=?",(turn,))
        self.conn.execute("INSERT INTO brief(project,text,summary_id) VALUES ('mine','secret','S-test')")
        db.add_artifact(self.conn,'mine','file','x',source_turn=turn)
        db.recycle_turn(self.conn,'mine',turn)
        db.purge(self.conn,self.tmp.name,'mine')
        self.assertIsNone(db.get_note(self.conn,note['id']))
        for table in ('summaries','brief','artifact'):
            self.assertEqual(self.conn.execute('SELECT count(*) FROM '+table+" WHERE project='mine'").fetchone()[0],0)

    def test_flat_round_and_mailbox_isolation(self):
        members = [dict(id='main',session_id='s-main',preset='secretary',role='main'),dict(id='a',session_id='s-a',preset='gm',role='child'),dict(id='b',session_id='s-b',preset='advisor',role='child')]
        organization.configure(self.conn,'mine','flat',members)
        organization.send(self.conn,'mine','s-a','b','review evidence')
        with self.assertRaises(ValueError):
            organization.inbox(self.conn,'other','s-b')
        with self.assertRaises(ValueError):
            organization.start_round(self.conn,'mine','s-a',{})
        result = organization.start_round(self.conn,'mine','s-main',{'a':'work'})
        self.assertEqual({a['member'] for a in result['activations']},{'a','b'})
        with self.assertRaises(ValueError):
            organization.start_round(self.conn,'mine','s-main',{})
        self.assertEqual(self.handler._dispatch('GET','/v1/taskboard',{'project':'mine','session_id':'s-a'}, {})[0],403)
        self.assertEqual(len(organization.inbox(self.conn,'mine','s-b',mark_read=True)),1)
        self.assertEqual(organization.inbox(self.conn,'mine','s-b'),[])
        organization.activation_status(self.conn,'mine',result['id'],'a','done')
        organization.activation_status(self.conn,'mine',result['id'],'b','done')
        self.assertTrue(any(a['member']=='main' for a in organization.pending(self.conn)))
        organization.activation_status(self.conn,'mine',result['id'],'main','done')
        self.assertEqual(organization.rounds(self.conn,'mine')[0]['status'],'completed')

    def test_tree_architecture_rejects_mail(self):
        members = [dict(id='main',session_id='s-main',preset='secretary',role='main')]
        organization.configure(self.conn,'mine','tree',members)
        with self.assertRaises(ValueError):
            organization.send(self.conn,'mine','s-main','main','hello')
        with self.assertRaises(ValueError):
            organization.inbox(self.conn,'mine','s-main')
        self.assertEqual(self.handler._dispatch('GET','/v1/member-messages',{'project':'mine','session_id':'s-main'}, {})[0],403)
        self.assertEqual(self.handler._dispatch('POST','/v1/member-messages/ack',{}, {'project':'mine','session_id':'s-main','ids':[]})[0],403)

if __name__ == '__main__': unittest.main()
