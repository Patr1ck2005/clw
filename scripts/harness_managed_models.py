"""Requested worker settings; observed browser values remain authoritative."""
import re
from harness_control_plane import label
from harness_state import require
from harness_team_common import text
from harness_managed_preparation import instructions

def effort_key(value):
    value=label(value)
    return {'low':'低','medium':'中','中等':'中','high':'高','extra high':'极高',
            'extra-high':'极高','xhigh':'极高','instant':'即时'}.get(value,value)

def model_key(value):
    """Compare a public choice across locales without changing its version."""
    return ' · '.join('latest' if part.strip()=='最新' else part.strip()
                      for part in label(value).split('·'))

def worker_enrollment_selection(settings,work_selection):
    """A parent's substantive Pro first turn is not a child's setup turn.

    Request Extra High on the same model family; the browser still has to
    discover and verify that option before sending. Never reuse Pro's slider
    position or description as an observation of Extra High.
    """
    selection=dict(settings.get('bootstrap_model_selection') or work_selection or {})
    if effort_key(selection.get('effort'))=='pro':
        selection={k:selection[k] for k in ('model','selection') if k in selection}
        selection['effort']='极高'
    return selection

def worker_settings(parent,settings,payload):
    model=label(text(payload.get('model',parent['model']),'model',160))
    effort=label(text(payload.get('effort',parent['effort']),'effort',160))
    selection=dict(settings.get('model_selection') or {})
    if model_key(model)!=model_key(parent['model']):
        selection={'selection':model.split(' · ')}
    if effort_key(effort)!=effort_key(parent['effort']):
        selection.pop('slider',None)
    selection.update(model=model,effort=effort)
    result={'model':model,'effort':effort,'model_selection':selection,'account':settings.get('account','B')}
    # A complete first task uses the requested work model in the same Send.
    # Only a setup-only/legacy preparation page keeps a separate setup model.
    initial=instructions(payload)
    bootstrap=selection if initial and payload.get('first_turn_mode','task_v1')=='task_v1' else worker_enrollment_selection(settings,selection)
    if bootstrap:result['bootstrap_model_selection']=bootstrap
    return result

def accept_observed(page,selection):
    require(isinstance(selection,dict),'managed_model_observation_mismatch',409)
    require(model_key(selection.get('model',''))==model_key(page['model']) and
            effort_key(selection.get('effort',''))==effort_key(page['effort']),
            'managed_model_observation_mismatch',409)
    return label(selection['model']),label(selection['effort'])

def latest_gpt6_choice(selection):
    """Only the single localized Latest choice in the GPT-6 major family."""
    return (isinstance(selection,dict) and
            re.fullmatch(r'gpt-6(?:\.\d+)*\s*·\s*(?:latest|最新)',label(selection.get('model',''))) is not None and
            isinstance(selection.get('selection'),list) and len(selection['selection'])==1 and
            model_key(selection['selection'][0])=='latest')

def accept_bootstrap_observed(page,settings,selection):
    """A setup-only Latest observation never changes the formal work model."""
    expected=settings.get('bootstrap_model_selection') or dict(page)
    require(isinstance(selection,dict),'managed_model_observation_mismatch',409)
    if model_key(selection.get('model',''))==model_key(expected['model']):
        return accept_observed(expected,selection)
    require(page['phase']=='reserved' and page['bootstrap_state']=='pending' and
            settings.get('work_model_pending') is True and
            settings.get('first_turn_mode')!='task_v1' and
            not str(settings.get('first_turn_instructions','')).strip() and
            latest_gpt6_choice(expected) and latest_gpt6_choice(selection) and
            effort_key(expected['effort'])=='极高' and effort_key(selection.get('effort',''))=='极高' and
            ('sliderCount' not in selection or selection['sliderCount']==1) and
            ('sliderContainerCount' not in selection or selection['sliderContainerCount']==1),
            'managed_model_observation_mismatch',409)
    return label(selection['model']),label(selection['effort'])
