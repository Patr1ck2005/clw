"""Explicit public context import. Never fetches other chats or infers decisions.

The source object is immutable and kept verbatim as structured JSON, with its
operator/receiver provenance. It is NOT verified scientific or project truth.
Importing a roster neither creates Sessions nor dispatches its proposed work.
"""
import json,uuid
from harness_state import canonical,require
from harness_team_common import object_fields,text,hash_value

class Intakes:
    def __init__(self,team):self.team=team
    @staticmethod
    def schema(db):
        db.executescript('''CREATE TABLE IF NOT EXISTS host_context_imports(
            id TEXT PRIMARY KEY,owner_thread TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS host_run_intakes(run_id TEXT PRIMARY KEY,intake_id TEXT NOT NULL);''')
    @staticmethod
    def validate(p):
        object_fields(p,{'name','source','objective','constraints','decisions','participants','references'})
        text(p['name'],'intake_name',200);text(p['objective'],'objective',16000)
        object_fields(p['source'],{'kind','reference','captured_at'})
        require(p['source']['kind'] in ('user_copy','controller_public_export'),'team_public_context_source_required')
        text(p['source']['reference'],'source_ref',2048);text(p['source']['captured_at'],'source_date',100)
        for key in ('constraints','decisions','references'):
            require(isinstance(p[key],list) and len(p[key])<=32,'team_intake_list_bounds')
            for item in p[key]:text(item,key,2000)
        require(isinstance(p['participants'],list),'team_roster_limit')
        seen=set()
        for person in p['participants']:
            object_fields(person,{'label','responsibility','progress','references'})
            name=text(person['label'],'participant_label',100)
            require(name not in seen,'team_duplicate_roster_label');seen.add(name)
            text(person['responsibility'],'responsibility',2000);text(person['progress'],'progress',3000,empty=True)
            require(isinstance(person['references'],list) and len(person['references'])<=16,'team_roster_references')
            for ref in person['references']:text(ref,'reference',1000)
        require(len(canonical(p).encode('utf-8'))<=90000,'team_intake_payload_bounds')
        return p
    def save(self,db,actor,p):
        self.validate(p)
        ident='clw-intake-'+uuid.uuid4().hex;digest=hash_value(p)
        db.execute('INSERT INTO host_context_imports VALUES(?,?,?,?,?)',(ident,actor['thread_id'],digest,canonical(p),self.team.host.clock()))
        return {'intake_id':ident,'hash':digest,'source':p['source'],'model_created':False,'roster_registered':False,'claims_verified':False}
    def read(self,db,actor,p):
        object_fields(p,{'intake_id'})
        row=db.execute('SELECT * FROM host_context_imports WHERE id=? AND owner_thread=?',(p['intake_id'],actor['thread_id'])).fetchone()
        require(row,'team_intake_not_owned',403)
        return {'intake_id':row['id'],'hash':row['hash'],'payload':json.loads(row['payload']),'claims_verified':False,'source_preserved':True}
    def attach(self,db,actor,run,intake):
        self.read(db,actor,{'intake_id':intake})
        db.execute('INSERT INTO host_run_intakes VALUES(?,?)',(run,intake))
