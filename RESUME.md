# Resuming the qarid build session after an SSH drop

This conversation's local Claude Code session id: `dd17f32e-29cc-4add-bcdc-d78a118a2184`

```sh
ssh -t <host> tmux new -A -s claude      # or, once on the box: tmux new -A -s claude
cd ~/Documents/side
claude --resume dd17f32e-29cc-4add-bcdc-d78a118a2184
```

Background agents/workflows that were in flight are resumable — Claude re-sends to them by id on resume.
