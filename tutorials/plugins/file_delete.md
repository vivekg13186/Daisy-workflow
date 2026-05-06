## Plugin name

**file.delete**\
Delete a file or directory safely from the filesystem. Prevents
accidental deletion of non-empty directories unless explicitly allowed.

---

## Prerequisites

- Node.js (v16+ recommended for `fs/promises`)
- Local file system access

### Optional (for testing/demo)

```bash
mkdir test-dir
echo "sample" > test-dir/file.txt
```

---

## Inputs

| Name      | Description                                              | Sample                |
| --------- | -------------------------------------------------------- | --------------------- |
| path      | Path to the file or directory to delete                  | "./test-dir/file.txt" |
| recursive | Allow deletion of directories (including non-empty ones) | true                  |
| missingOk | Do not throw error if file does not exist                | true                  |

## Outputs

| Name    | Description               | Sample                   |
| ------- | ------------------------- | ------------------------ |
| path    | Absolute resolved path    | "/app/test-dir/file.txt" |
| deleted | Whether deletion occurred | true                     |

## Sample workflow

```yaml
name: file-delete-example
description: |
  Demonstrates deleting a file safely with optional flags.

data:
  filePath: "./test-dir/file.txt"

nodes:
  - name: start
    action: log
    inputs:
      - message: "Attempting to delete ${filePath}"

  - name: deleteFile
    action: file.delete
    inputs:
      - path: "${filePath}"
      - recursive: false
      - missingOk: true
    outputs:
      - deleted: wasDeleted
      - path: resolvedPath

  - name: result
    action: log
    inputs:
      - message: "Deleted: ${wasDeleted} at ${resolvedPath}"

edges:
  - from: start
    to: deleteFile
  - from: deleteFile
    to: result
```

---

## Expected output

Successful deletion:

```json
{
  "path": "/absolute/path/to/test-dir/file.txt",
  "deleted": true
}
```

If file does not exist and `missingOk: true`:

```json
{
  "path": "/absolute/path/to/test-dir/file.txt",
  "deleted": false
}
```

---

## Troubleshooting

### ENOENT (file not found)

- Cause: File does not exist\
- Fix:
  - Set `missingOk: true`\
  - Verify correct path

---

### Directory deletion error

    file.delete: "<path>" is a directory; pass recursive:true to remove

- Cause: Trying to delete a directory without `recursive: true`\
- Fix: Enable `recursive: true`

---

### Permission denied (EACCES)

- Cause: Insufficient permissions\
- Fix:
  - Run with proper permissions\
  - Check file ownership

---

### Unsafe path error

- Cause: Invalid or restricted path\
- Fix:
  - Avoid `../` traversal\
  - Ensure path is within allowed scope

---

## Library

- Node.js `fs/promises` (`rm`, `stat`)
- Custom utility: `resolveSafePath`

---

## Reference

- https://nodejs.org/api/fs.html#fspromisesrmpath-options\
- https://nodejs.org/api/fs.html#fspromisesstatpath-options
