// Quiet the JSON logger during tests — saves the output streams from
// being filled with "mqtt subscribed" / "mqtt error" lines that aren't
// part of the assertions.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
