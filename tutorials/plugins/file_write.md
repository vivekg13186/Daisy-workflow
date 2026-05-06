# file.write

This plugin writes string or base64 data to the file system. It supports both overwriting existing files and appending to them, with an optional feature to automatically create parent directories.

## Prerequisites
* **Write Permissions:** The environment must have permission to write to the target directory.
* **Storage Space:** Ensure sufficient disk space is available for the content being written.
* **Directory Access:** If `mkdir` is set to `false`, the parent directory must already exist or the plugin will fail.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | Destination path for the file. | `./output/report.txt` |
| `content` | The data to write to the file. | `Hello World` |
| `encoding` | Character encoding (`utf8`, `ascii`, `base64`, etc.). | `utf8` |
| `mode` | `overwrite` (replaces file) or `append` (adds to end). | `overwrite` |
| `mkdir` | If `true`, creates missing parent folders. | `true` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `path` | The absolute path where the file was written. | `/app/output/report.txt` |
| `size` | The final size of the file in bytes. | `1024` |

## Sample workflow
```yaml
name: write-log-entry
description: |
  Appends a log entry to a file. It ensures the directory exists 
  using the mkdir option.

data:
  logFile: "./data/audit/events.log"
  entry: "User login detected at 12:00 PM\n"

nodes:
  - name: write_log
    action: file.write
    inputs:
      - path: "${logFile}"
      - content: "${entry}"
      - mode: "append"
      - mkdir: true
    outputs:
      - size: currentFileSize

  - name: notify_success
    action: log
    inputs:
      - message: "Log updated. Total file size: ${currentFileSize} bytes."

edges:
  - from: write_log
    to: notify_success
```

## Expected output
Upon a successful write operation, the plugin returns the path and the file size:
```json
{
  "path": "/home/user/project/data/audit/events.log",
  "size": 1240
}
```

## Troubleshooting
* **ENOENT (No such file or directory):** Occurs if the parent directory doesn't exist and `mkdir` is set to `false`.
* **EACCES (Permission denied):** The system user running the plugin does not have write access to that path.
* **Invalid Base64:** If `encoding` is set to `base64` but the `content` is not a valid base64 string, the resulting file may be corrupted.

## Library
* `node:fs/promises` - Native Node.js module for asynchronous file operations.
* `node:path` - Native Node.js module for handling file paths.

## Reference
* [Node.js writeFile Documentation](https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options)
* [Node.js mkdir Documentation](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options)
