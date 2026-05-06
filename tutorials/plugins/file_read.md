## Plugin name

**file.read**\
Read a file from disk and return its contents in the specified encoding.

---

## Prerequisites

- Node.js (v16+ recommended for `fs/promises`)
- Local file system access

### Optional (for testing/demo)

```bash
echo "hello world" > sample.txt
```

---

## Inputs

| Name     | Description                      | Sample         |
| -------- | -------------------------------- | -------------- |
| path     | Path to the file to read         | "./sample.txt" |
| encoding | Encoding format for file content | "utf8"         |

## Outputs

| Name     | Description            | Sample            |
| -------- | ---------------------- | ----------------- |
| path     | Absolute resolved path | "/app/sample.txt" |
| content  | File content           | "hello world"     |
| size     | File size in bytes     | 11                |
| encoding | Encoding used          | "utf8"            |

## Sample workflow

```yaml
name: file-read-example
description: |
  Demonstrates reading a file from disk.

data:
  filePath: "./sample.txt"

nodes:
  - name: start
    action: log
    inputs:
      - message: "Reading file ${filePath}"

  - name: readFile
    action: file.read
    inputs:
      - path: "${filePath}"
      - encoding: "utf8"
    outputs:
      - content: fileContent
      - size: fileSize
      - path: resolvedPath

  - name: result
    action: log
    inputs:
      - message: "Read ${fileSize} bytes from ${resolvedPath}: ${fileContent}"

edges:
  - from: start
    to: readFile
  - from: readFile
    to: result
```

---

## Expected output

```json
{
  "path": "/absolute/path/to/sample.txt",
  "content": "hello world",
  "size": 11,
  "encoding": "utf8"
}
```

---

## Troubleshooting

### ENOENT (file not found)

- Cause: File does not exist\
- Fix: Verify file path

---

### Unsupported encoding

- Cause: Invalid encoding value\
- Fix: Use supported values:
  - utf8 / utf-8
  - ascii
  - latin1
  - base64

---

### Permission denied (EACCES)

- Cause: Insufficient permissions\
- Fix:
  - Check file permissions\
  - Run with proper access

---

### Binary data issues

- Cause: Reading binary file with text encoding\
- Fix:
  - Use `base64` encoding for binary files

---

## Library

- Node.js `fs/promises` (`readFile`, `stat`)
- Custom utility: `resolveSafePath`

---

## Reference

- https://nodejs.org/api/fs.html#fspromisesreadfilepath-options\
- https://nodejs.org/api/fs.html#fspromisesstatpath-options
