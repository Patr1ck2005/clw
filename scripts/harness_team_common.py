"""Bounded domain-neutral helpers. No provider calls, filesystem discovery or retries."""
from __future__ import annotations
import hashlib,json,re
from harness_state import require,canonical

def object_fields(value, required, optional=()):
    require(isinstance(value,dict) and set(required)<=set(value)<=set(required)|set(optional),'team_payload_fields')
    return value

def text(value,name='text',limit=12000,empty=False):
    require(isinstance(value,str) and len(value)<=limit and (empty or bool(value.strip())) and '\x00' not in value,'team_'+name+'_invalid')
    return value

def identifier(value):
    require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value),'team_identifier_invalid')
    return value

def integer(value,low,high):
    require(type(value) is int and low<=value<=high,'team_integer_bounds')
    return value

def names(value,limit=32):
    require(isinstance(value,list) and len(value)<=limit,'team_list_bounds')
    result=[identifier(v) for v in value]
    require(len(set(result))==len(result),'team_duplicate_identifier')
    return result

def hash_value(value):return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()

def load(row):return dict(row) if row is not None else None
