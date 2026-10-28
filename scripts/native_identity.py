"""Bounded native identities shared by observation and task binding.

Preserve the previously accepted legacy Session spelling without rewriting it.
The compact native generation adds exactly sixteen URL-safe suffix characters;
adding hyphens to the unbounded legacy branch would admit malformed new IDs.
An accepted spelling is never proof of Project access or account ownership.
"""
import re

SESSION_RE = re.compile(r'wc_sess_(?:[A-Za-z0-9_]{1,112}|[A-Za-z0-9_-]{16})\Z')
