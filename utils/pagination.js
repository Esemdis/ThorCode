//pagination utility function
function paginate({ page, limit }) {
  const skip = (page - 1) * limit;
  return {
    skip,
  };
}
