'use strict';

// The public app name is part of each account's execution contract. A legacy
// display name or another app is never an alias for this selected connector.
// The public composer may lowercase the same label. Fold ASCII letters only:
// account suffixes, punctuation, spacing and app paths keep their identity.
function sameConnectorLabel(observed,expected){
  if(typeof observed!=='string'||typeof expected!=='string'||!observed||!expected)return false;
  const fold=value=>value.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32));
  return fold(observed)===fold(expected);
}
const CONNECTORS=Object.freeze({A:'Local-MCP',B:'Local-MCP-B'});
function connectorForAccount(account='B'){
  if(!Object.hasOwn(CONNECTORS,account))throw Error('connector_account_unknown');
  return CONNECTORS[account];
}
function connectorNames(){return Object.values(CONNECTORS);}
module.exports={CONNECTORS,connectorForAccount,connectorNames,sameConnectorLabel};
