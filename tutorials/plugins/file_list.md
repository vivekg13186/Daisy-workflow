## Plugin name  
**file.list**  
List entries in a directory. Supports optional glob filtering and recursive traversal of subdirectories.

---

## Prerequisites  

- Node.js (v16+ recommended for `fs/promises`)
- Access to local file system

### Optional (for testing/demo)
```bash
mkdir -p demo/a
mkdir -p demo/b
echo "file1" > demo/a/test1.txt
echo "file2" > demo/b/test2.txt
```

---

## Inputs  

| Name          | Description                                      | Sample        |
| ------------- | ------------------------------------------------ | ------------- |
| path          | Directory path to list                          | "./demo"      |
| pattern       | Optional glob filter (* and ?)                  | "*.txt"       |
| recursive     | Recursively list subdirectories                | true          |
| includeHidden | Include hidden files/folders (dotfiles)        | false         |

---

## Outputs  

| Name    | Description               | Sample                   |
| ------- | ------------------------- | ------------------------ |
| entries | List of file/directory entries | [{"name":"test1.txt"}] |
| count   | Total number of matched entries | 2 |

---

## Sample workflow  

```yaml
name: file-list-example
description: |
  Demonstrates listing files in a directory with optional recursion and filtering.

data:
  dirPath: "./demo"

nodes:
  - name: start
    action: log
    inputs:
      - message: "Listing directory ${dirPath}"

  - name: listFiles
    action: file.list
    inputs:
      - path: "${dirPath}"
      - pattern: "*.txt"
      - recursive: true
      - includeHidden: false
    outputs:
      - entries: fileEntries
      - count: totalFiles

  - name: result
    action: log
    inputs:
      - message: "Found ${totalFiles} files"

edges:
  - from: start
    to: listFiles
  - from: listFiles
    to: result
```

---

## Expected output  

```json
{
  "entries": [
    {
      "name": "test1.txt",
      "path": "/absolute/path/demo/a/test1.txt",
      "isFile": true,
      "isDirectory": false,
      "size": 5,
      "mtime": "2026-05-06T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

---

## Troubleshooting  

### Directory not found (ENOENT)
- Cause: Invalid path  
- Fix: Verify directory exists  

---

### Pattern not matching results
- Cause: Incorrect glob pattern  
- Fix:  
  - Use `*.txt` for extensions  
  - Use `*` for all files  

---

### Permission denied (EACCES)
- Cause: No access to directory  
- Fix:  
  - Adjust permissions  
  - Run with proper access rights  

---

### Empty results
- Cause: Hidden files excluded or wrong filter  
- Fix:  
  - Set `includeHidden: true` if needed  
  - Remove or adjust pattern  

---

## Library  

- Node.js `fs/promises` (`readdir`, `stat`)
- Node.js `path`
- Custom utilities:
  - `resolveSafePath`
  - `globToRegExp`

---

## Reference  

- https://nodejs.org/api/fs.html#fspromisesreaddirpath-options  
- https://nodejs.org/api/fs.html#fspromisesstatpath-options  
