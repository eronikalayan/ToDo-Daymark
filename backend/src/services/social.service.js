const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/app-error');
const { toPublicUser } = require('../utils/safe-user');

const publicPersonSelect = { id: true, name: true, email: true, createdAt: true, updatedAt: true };

async function getFriendship(userId, friendId, status = 'accepted') {
  const friendship = await prisma.friendship.findFirst({
    where: {
      status,
      OR: [
        { requesterId: userId, addresseeId: friendId },
        { requesterId: friendId, addresseeId: userId }
      ]
    },
    select: { id: true }
  });
  if (!friendship) throw new AppError(404, 'Friend not found.', 'FRIEND_NOT_FOUND');
  return friendship;
}

async function listFriends(userId) {
  const records = await prisma.friendship.findMany({
    where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
    include: {
      requester: { select: publicPersonSelect },
      addressee: { select: publicPersonSelect }
    },
    orderBy: { createdAt: 'desc' }
  });

  const friends = [];
  const requests = [];
  for (const record of records) {
    const isRequester = record.requesterId === userId;
    const other = isRequester ? record.addressee : record.requester;
    if (record.status === 'accepted') friends.push(toPublicUser(other));
    else requests.push({
      id: record.id,
      direction: isRequester ? 'sent' : 'received',
      user: toPublicUser(other),
      createdAt: record.createdAt
    });
  }
  return { friends, requests };
}

async function sendFriendRequest(userId, email) {
  const other = await prisma.user.findUnique({ where: { email }, select: publicPersonSelect });
  if (!other) throw new AppError(404, 'No user was found for that email.', 'USER_NOT_FOUND');
  if (other.id === userId) throw new AppError(422, 'You cannot add yourself as a friend.', 'SELF_FRIEND_REQUEST');

  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: userId, addresseeId: other.id },
        { requesterId: other.id, addresseeId: userId }
      ]
    }
  });
  if (existing?.status === 'accepted') throw new AppError(409, 'You are already friends.', 'ALREADY_FRIENDS');
  if (existing?.requesterId === other.id && existing?.status === 'pending') {
    const accepted = await prisma.friendship.update({
      where: { id: existing.id },
      data: { status: 'accepted' }
    });
    return { id: accepted.id, status: accepted.status, user: toPublicUser(other) };
  }
  if (existing) throw new AppError(409, 'A friend request is already pending.', 'REQUEST_ALREADY_PENDING');

  const request = await prisma.friendship.create({
    data: { requesterId: userId, addresseeId: other.id },
    select: { id: true, status: true, createdAt: true }
  });
  return { ...request, user: toPublicUser(other) };
}

async function decideFriendRequest(userId, requestId, action) {
  const request = await prisma.friendship.findFirst({
    where: { id: requestId, addresseeId: userId, status: 'pending' },
    include: { requester: { select: publicPersonSelect } }
  });
  if (!request) throw new AppError(404, 'Friend request not found.', 'REQUEST_NOT_FOUND');
  if (action === 'decline') {
    await prisma.friendship.deleteMany({ where: { id: request.id, addresseeId: userId, status: 'pending' } });
    return { id: request.id, status: 'declined', user: toPublicUser(request.requester) };
  }
  const updated = await prisma.friendship.updateMany({
    where: { id: request.id, addresseeId: userId, status: 'pending' },
    data: { status: 'accepted' }
  });
  if (!updated.count) throw new AppError(409, 'Friend request was already handled.', 'REQUEST_ALREADY_HANDLED');
  return { id: request.id, status: 'accepted', user: toPublicUser(request.requester) };
}

async function removeFriend(userId, friendId) {
  const friendship = await getFriendship(userId, friendId);
  await prisma.friendship.deleteMany({ where: { id: friendship.id } });
}

async function listMessages(userId, friendId, { page, limit }) {
  await getFriendship(userId, friendId);
  const where = {
    OR: [
      { senderId: userId, recipientId: friendId },
      { senderId: friendId, recipientId: userId }
    ]
  };
  const [records, total] = await prisma.$transaction([
    prisma.chatMessage.findMany({
      where,
      include: { sender: { select: publicPersonSelect } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.chatMessage.count({ where })
  ]);
  return {
    messages: records.reverse().map((message) => ({
      id: message.id,
      sender: toPublicUser(message.sender),
      recipientId: message.recipientId,
      taskId: message.taskId,
      body: message.body,
      createdAt: message.createdAt
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  };
}

async function sendMessage(userId, friendId, body) {
  await getFriendship(userId, friendId);
  const message = await prisma.chatMessage.create({
    data: { senderId: userId, recipientId: friendId, body },
    include: { sender: { select: publicPersonSelect } }
  });
  return {
    id: message.id,
    sender: toPublicUser(message.sender),
    recipientId: message.recipientId,
    taskId: message.taskId,
    body: message.body,
    createdAt: message.createdAt
  };
}

module.exports = { listFriends, sendFriendRequest, decideFriendRequest, removeFriend, listMessages, sendMessage };
