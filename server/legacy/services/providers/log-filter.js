const { AppError } = require("../../utils/error");

function parseTimestampedLine(line) {
  const match = line.match(/^(\S+)\s(.*)$/);
  if (!match) {
    return { timestamp: null, message: line };
  }
  return {
    timestamp: match[1],
    message: match[2]
  };
}

function filterByTimeRange(items, startTime, endTime) {
  if (!startTime && !endTime) {
    return items;
  }

  const start = startTime ? new Date(startTime).getTime() : null;
  const end = endTime ? new Date(endTime).getTime() : null;

  if ((startTime && Number.isNaN(start)) || (endTime && Number.isNaN(end))) {
    throw new AppError("startTime/endTime must be valid ISO date-time strings.", 400);
  }

  return items.filter((item) => {
    if (!item.timestamp) {
      return false;
    }
    const ts = new Date(item.timestamp).getTime();
    if (Number.isNaN(ts)) {
      return false;
    }
    if (start !== null && ts < start) {
      return false;
    }
    if (end !== null && ts > end) {
      return false;
    }
    return true;
  });
}

function filterByKeyword(items, keyword) {
  if (!keyword) {
    return items;
  }
  const normalized = String(keyword).toLowerCase();
  return items.filter((item) => item.message.toLowerCase().includes(normalized));
}

function parseTailLines(tailLines) {
  const parsedTail = tailLines === undefined || tailLines === null || tailLines === ""
    ? undefined
    : Number(tailLines);
  if (parsedTail !== undefined && (!Number.isInteger(parsedTail) || parsedTail <= 0)) {
    throw new AppError("tailLines must be a positive integer.", 400);
  }
  return parsedTail;
}

function rawLogToEntries(podName, rawLog) {
  const lines = String(rawLog || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const parsed = parseTimestampedLine(line);
    return {
      pod: podName,
      timestamp: parsed.timestamp,
      message: parsed.message
    };
  });
}

module.exports = {
  filterByTimeRange,
  filterByKeyword,
  parseTailLines,
  rawLogToEntries
};
