// Return an allowlisted user shape so password hashes never leave the service layer.
function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

module.exports = { toPublicUser };
