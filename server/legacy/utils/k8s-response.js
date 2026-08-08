function unwrapK8sResponse(result) {
  if (result && result.body !== undefined) {
    return result.body;
  }

  if (result && result.response && result.response.body !== undefined) {
    return result.response.body;
  }

  return result;
}

module.exports = {
  unwrapK8sResponse
};
