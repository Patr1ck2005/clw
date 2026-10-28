# Native WebCodex source archive

This directory preserves the native source used by CLW's Server, Runner and
CLI, including the 2026-10-18 stability build. It is a source archive, not a second runtime or an
installer. CLW's main Git repository and this native source have separate
histories.

The source was captured from a clean WebCodex worktree. Its existing shallow
baseline is `37098d4624f0000bfab54ad102ecb0df619d7dc6`.
The current archive retains that boundary and all five original commit IDs; earlier
upstream history is not included.

| Commit after the baseline | Change |
| --- | --- |
| `9ae45a2a0ad7e0de170d35075cc7ff12c4b64d98` | Bound Runner WebSocket silence and clarify transport status. |
| `3fb0ecaac9942405a1f5b0bf52a86f646b92bf5f` | Keep heartbeats responsive while project scans run. |
| `6d67dfd132e402d559b8e46465ed2cbcbcac8bd2` | Bound optional startup checks and resolve only the target project. |
| `87117c05bed495089c7119937f1067e2f1be29d2` | Accept canonical timeout states for completion notifications and back off each failed notification retry. |

All four commits after the baseline carry
`Origin: ai-assisted:gpt-6.1-sol-codex`. Their original commit data is retained.
The four `patches/*.patch` files are for reviewing or applying the changes to
another checkout; use the Git archive below to recover the exact commit IDs.

## Restore the exact source

`source-git-87117c05bed4.zip` contains only reachable Git objects, their index,
the original shallow boundary, HEAD and
`refs/heads/codex/runner-stability-20261018`. No source Git configuration,
reflogs, credentials, runtime data or binaries are copied.

In PowerShell, choose a new, empty destination and run:

```powershell
Get-FileHash -Algorithm SHA256 .\source-git-87117c05bed4.zip
Expand-Archive -LiteralPath .\source-git-87117c05bed4.zip -DestinationPath C:\Temp\clw-native-restore
git -C C:\Temp\clw-native-restore\native-runtime-source config core.filemode false
git -C C:\Temp\clw-native-restore\native-runtime-source reset --hard 87117c05bed495089c7119937f1067e2f1be29d2
git -C C:\Temp\clw-native-restore\native-runtime-source fsck --full
git -C C:\Temp\clw-native-restore\native-runtime-source status --porcelain=v1
git -C C:\Temp\clw-native-restore\native-runtime-source rev-parse HEAD 'HEAD^{tree}'
```

`core.filemode=false` is a local Windows checkout setting; executable modes in
the archived tree remain intact. On a filesystem that preserves executable
modes, this setting is unnecessary. Successful `fsck` exits with 0, status is
empty, HEAD is `87117c05bed495089c7119937f1067e2f1be29d2`, and its tree is
`2ff5e78f09824025bc2b31dba5e38123bf1ffcf3`.

Archive SHA256:
`789decc0778b508e3147453a64b91985ceaab87ac8ae9a76fb5075ef9fcd0e65`
(11,069,251 bytes). `manifest.json` records every archived entry and the
patch/license file sizes and SHA256 hashes.

The current archive was actually extracted into an empty directory, checked
out and verified with these Git checks. The original `source-git-6d67dfd132e4.zip`
remains unchanged for previous-build recovery; its SHA256 is
`c01c7f5b9f7f12ebbc87e99ad996007a370f434f621d4edcc331e0ff2cd3fc02`.

## Terminal attention fix (2026-10-18)

`patches/0004-terminal-attention-timeout-retry.patch` is a later source-only
change against the exact `6d67` base. It accepts both canonical timeout
spellings for completion notifications, preserves the original Job status and
adds a 30-second retry delay per failed notification. It adds no scheduler or
execution replay. `git apply --check --cached` against the unchanged base index
passed; the patch can be applied after restoring the original archive.

The current `87117c05bed4` archive contains this change. The old `6d67` archive
and previous installer do not. Packaging an archive does not imply a running
installation has upgraded; deployed build identity and acceptance are recorded
separately in `CURRENT.md`.

## License

The native WebCodex source is **Apache-2.0**, as declared in its source
`Cargo.toml` and `LICENSE`. `LICENSE-APACHE-2.0` is the exact LICENSE blob from
commit `6d67dfd132e402d559b8e46465ed2cbcbcac8bd2`, SHA256
`c95bae1d1ce0235ecccd3560b772ec1efb97f348a79f0fbe0a634f0c2ccefe2c`.
CLW's separate free-preview terms do not replace the native source license.
