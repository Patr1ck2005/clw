"""Public connector names for the two isolated, configured Web accounts."""

def connector_name(account):
    return {'A': 'Local-MCP', 'B': 'Local-MCP-B'}[account]
