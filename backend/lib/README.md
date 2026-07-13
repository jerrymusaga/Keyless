# Dependencies

This project uses `forge-std` for tests and scripts. It is not vendored here to keep the
zip small. After unzipping, run:

```bash
cd backend
forge install foundry-rs/forge-std
```

This populates `lib/forge-std/`, which `remappings.txt` already points at.
