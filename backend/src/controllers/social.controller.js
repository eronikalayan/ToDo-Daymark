const socialService = require('../services/social.service');

async function listFriends(request, response) {
  response.status(200).json({ data: await socialService.listFriends(request.user.id) });
}

async function sendFriendRequest(request, response) {
  const requestRecord = await socialService.sendFriendRequest(request.user.id, request.validated.body.email);
  response.status(201).json({ data: { request: requestRecord } });
}

async function decideFriendRequest(request, response) {
  const result = await socialService.decideFriendRequest(
    request.user.id,
    request.validated.params.id,
    request.validated.body.action
  );
  response.status(200).json({ data: { request: result } });
}

async function removeFriend(request, response) {
  await socialService.removeFriend(request.user.id, request.validated.params.friendId);
  response.status(204).end();
}

async function listMessages(request, response) {
  const result = await socialService.listMessages(
    request.user.id,
    request.validated.params.friendId,
    request.validated.query
  );
  response.status(200).json({ data: { messages: result.messages }, meta: { pagination: result.pagination } });
}

async function sendMessage(request, response) {
  const message = await socialService.sendMessage(
    request.user.id,
    request.validated.params.friendId,
    request.validated.body.body
  );
  response.status(201).json({ data: { message } });
}

module.exports = { listFriends, sendFriendRequest, decideFriendRequest, removeFriend, listMessages, sendMessage };
