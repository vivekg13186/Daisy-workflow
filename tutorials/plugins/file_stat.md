# file.stat

This plugin checks whether a specific file or directory path exists on the system. It retrieves essential metadata such as size, type, and modification time without throwing errors if the path is missing.

## Prerequisites
* **Node.js Environment:** Ensure your runner has access to the local or containerized file system.
* **Permissions:** The process must have read permissions for the target directory.
* **Mock setup:** You can test this by creating a simple dummy file: `echo "hello" > test.txt`

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The relative or absolute path to check. | `./data/config.json` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The resolved absolute path. | `/app/data/config.json` |
| `exists` | Boolean indicating if the path exists. | `true` |
| `isFile` | True if the path is a regular file. | `true` |
| `isDirectory` | True if the path is a directory. | `false` |
| `size` | The file size in bytes. | `1024` |
| `mtime` | Last modification time in ISO format. | `2024-05-06T14:00:00Z` |

## Sample workflow
```yaml
name: check-file-status
description: |
  Checks if a log file exists. If it does, logs the size;
  otherwise, logs a missing file warning.

data:
  targetPath: "./logs/app.log"

nodes:
  - name: check_file
    action: file.stat
    inputs:
      - path: "${targetPath}"
    outputs:
      - exists: fileExists
      - size: fileSize

  - name: log_exists
    action: log
    executeIf: "${fileExists == true}"
    inputs:
      - message: "File found! Size is ${fileSize} bytes."

  - name: log_missing
    action: log
    executeIf: "${fileExists == false}"
    inputs:
      - message: "Warning: ${targetPath} does not exist."

edges:
  - from: check_file
    to: log_exists
  - from: check_file
    to: log_missing
```

## Expected output
If the file exists:
```json
{
  "path": "/absolute/path/to/logs/app.log",
  "exists": true,
  "isFile": true,
  "isDirectory": false,
  "size": 450,
  "mtime": "2024-05-06T16:41:59.000Z"
}
```

## Troubleshooting
* **Permission Denied (EACCES):** The plugin will throw an error if it doesn't have permission to access the path. Check folder permissions.
* **Path Resolution:** The `resolveSafePath` utility may restrict access to files outside of the application root for security reasons.
* **ENOENT:** This plugin is designed NOT to crash on "File Not Found" (ENOENT); it will simply return `exists: false`.

## Library
* `node:fs/promises` - Native Node.js File System module using Promise-based APIs.

## Reference
* [Node.js fs.stat Documentation](https://nodejs.org/api/fs.html#fspromisesstatpath-options)
