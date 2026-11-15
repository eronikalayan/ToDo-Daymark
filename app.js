(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const API_BASE_URL = (() => {
    const configured = $('meta[name="api-base-url"]')?.content.trim() || window.DAYMARK_API_BASE_URL;
    if (configured) return configured.replace(/\/$/, '');
    if (location.protocol === 'file:') return '';
    if (location.port === '4000') return `${location.origin}/api`;
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return 'http://localhost:4000/api';
    return '/api';
  })();
  const authScreen = $('#authScreen');
  const appScreen = $('#appScreen');
  const authForm = $('#authForm');
  const authMessage = $('#authMessage');
  const apiError = $('#apiError');
  const taskForm = $('#taskForm');
  const taskInput = $('#taskInput');
  const taskDate = $('#taskDate');
  const taskList = $('#taskList');
  const searchInput = $('#searchInput');
  const tasksSection = $('#tasksSection');
  const friendsPanel = $('#friendsPanel');
  const calendarPanel = $('#calendarPanel');
  const chatPanel = $('#chatPanel');
  const appMessage = $('#appMessage');

  let currentUser = null;
  let tasks = [];
  let friends = [];
  let friendRequests = [];
  let activeFilter = 'all';
  let activeChatFriendId = '';
  let chatMessages = [];
  let chatPollTimer = null;
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedCalendarDate = localDateString();
  let draggedTaskId = '';
  let friendsView = false;

  function localDateString(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function taskDateValue(task) {
    return task.dueDate ? String(task.dueDate).slice(0, 10) : '';
  }

  async function api(path, options = {}) {
    if (!API_BASE_URL) {
      throw new Error('Serve this page over localhost (not file://) and start the backend. See backend/README.md.');
    }
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
        credentials: 'include'
      });
    } catch {
      throw new Error(`Could not reach the Daymark API at ${API_BASE_URL}. Start the backend and check its CORS_ORIGIN setting.`);
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = payload?.error?.code;
      if (response.status === 401 && currentUser) {
        showSignedOut('Your session expired. Please sign in again.');
      } else if (response.status === 422 && payload?.error?.details) {
        error.message = payload.error.details.map((item) => `${item.path || 'input'}: ${item.message}`).join(' ');
      }
      throw error;
    }
    return payload;
  }

  function setAuthMode(registering) {
    $('#authTitle').textContent = registering ? 'Create your account' : 'Welcome back';
    $('#authIntro').textContent = registering ? 'Start a calmer, clearer way to plan your work.' : 'Sign in to pick up where you left off.';
    $('#authSubmit').textContent = registering ? 'Create account' : 'Sign in';
    $('#switchPrompt').textContent = registering ? 'Already have an account?' : 'New to Daymark?';
    $('#switchAuth').textContent = registering ? 'Sign in' : 'Create an account';
    $('#nameField').classList.toggle('hidden', !registering);
    $('#name').required = registering;
    $('#password').autocomplete = registering ? 'new-password' : 'current-password';
    $('#confirmField').classList.toggle('hidden', !registering);
    $('#confirmPassword').required = registering;
    authMessage.textContent = '';
    $('#resendVerification').classList.add('hidden');
  }

  function setAppMessage(message = '', isError = false) {
    appMessage.textContent = message;
    appMessage.classList.toggle('error', isError);
  }

  function showSignedOut(message = '') {
    stopChatPolling();
    currentUser = null;
    tasks = [];
    friends = [];
    friendRequests = [];
    chatMessages = [];
    activeChatFriendId = '';
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
    authForm.reset();
    setAppMessage('');
    $('#recoveryForm').classList.add('hidden');
    $('#resetPasswordForm').classList.add('hidden');
    authForm.classList.remove('hidden');
    setAuthMode(false);
    authMessage.textContent = message;
  }

  function showSignIn(message = '') {
    $('#recoveryForm').classList.add('hidden');
    $('#resetPasswordForm').classList.add('hidden');
    authForm.classList.remove('hidden');
    setAuthMode(false);
    authMessage.textContent = message;
  }

  function startBusy(button, label = 'Working…') {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = label;
  }

  function stopBusy(button) {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }

  $('#switchAuth').addEventListener('click', () => {
    setAuthMode($('#nameField').classList.contains('hidden'));
  });

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authMessage.textContent = '';
    const submit = $('#authSubmit');
    const registering = !$('#nameField').classList.contains('hidden');
    const email = $('#email').value.trim().toLowerCase();
    const password = $('#password').value;
    if (!$('#email').checkValidity()) {
      authMessage.textContent = 'Enter a valid email address.';
      $('#email').focus();
      return;
    }
    if (password.length < 8) {
      authMessage.textContent = 'Your password must be at least 8 characters.';
      $('#password').focus();
      return;
    }
    if (registering && $('#confirmPassword').value !== password) {
      authMessage.textContent = 'Those passwords don’t match yet.';
      $('#confirmPassword').focus();
      return;
    }

    startBusy(submit, registering ? 'Creating…' : 'Signing in…');
    try {
      const payload = registering
        ? await api('/auth/register', { method: 'POST', body: JSON.stringify({ name: $('#name').value.trim(), email, password }) })
        : await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (payload.meta?.verificationRequired) {
        showSignedOut('Check your email for a verification link before signing in.');
        return;
      }
      await openWorkspace(payload.data.user);
    } catch (error) {
      authMessage.textContent = error.code === 'INVALID_CREDENTIALS'
        ? `${error.message}. Accounts from the earlier browser-only demo were not transferred; create a new account if you used that version.`
        : error.message;
      $('#resendVerification').classList.toggle('hidden', error.code !== 'EMAIL_NOT_VERIFIED');
    } finally {
      stopBusy(submit);
    }
  });

  $('#resendVerification').addEventListener('click', async () => {
    const button = $('#resendVerification');
    startBusy(button, 'Sending…');
    try {
      const email = $('#email').value.trim().toLowerCase();
      await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      authMessage.textContent = 'If that account needs verification, a link will be sent.';
      button.classList.add('hidden');
    } catch (error) {
      authMessage.textContent = error.message;
    } finally {
      stopBusy(button);
    }
  });

  $('#forgotPassword').addEventListener('click', () => {
    $('#recoveryEmail').value = $('#email').value.trim();
    authForm.classList.add('hidden');
    $('#resetPasswordForm').classList.add('hidden');
    $('#recoveryForm').classList.remove('hidden');
    $('#recoveryMessage').textContent = '';
    $('#recoveryEmail').focus();
  });
  document.querySelectorAll('.back-to-login').forEach((button) => button.addEventListener('click', () => showSignIn()));

  $('#recoveryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = $('#recoveryForm');
    const submit = form.querySelector('button[type="submit"]');
    startBusy(submit, 'Sending…');
    try {
      const email = $('#recoveryEmail').value.trim().toLowerCase();
      await api('/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) });
      $('#recoveryMessage').textContent = 'If that account exists, a password reset link will be sent.';
    } catch (error) {
      $('#recoveryMessage').textContent = error.message;
    } finally {
      stopBusy(submit);
    }
  });

  $('#resetPasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('#newPassword').value;
    const message = $('#resetMessage');
    if (password.length < 8) {
      message.textContent = 'Your password must be at least 8 characters.';
      return;
    }
    if (password !== $('#newPasswordConfirm').value) {
      message.textContent = 'Those passwords don’t match yet.';
      return;
    }
    const submit = $('#resetPasswordForm').querySelector('button[type="submit"]');
    startBusy(submit, 'Updating…');
    try {
      await api('/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token: $('#resetToken').value, password })
      });
      history.replaceState({}, '', `${location.pathname}${location.hash}`);
      showSignIn('Your password has been updated. Sign in with your new password.');
      authForm.reset();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      stopBusy(submit);
    }
  });

  async function openWorkspace(user) {
    currentUser = user;
    setAppMessage('');
    activeFilter = 'all';
    activeChatFriendId = '';
    selectedCalendarDate = localDateString();
    calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    searchInput.value = '';
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    $('#profileName').textContent = user.name;
    $('#profileEmail').textContent = user.email;
    $('#profileAvatar').textContent = (user.name[0] || user.email[0]).toUpperCase();
    updateDate();
    render();
    try {
      await Promise.all([loadTasks(), loadFriends()]);
      render();
      taskInput.focus();
    } catch (error) {
      setAppMessage(error.message, true);
    }
  }

  async function loadTasks() {
    const loaded = [];
    let page = 1;
    while (true) {
      const result = await api(`/tasks?page=${page}&limit=100&sortBy=createdAt&order=asc`);
      const pageTasks = result.data.tasks;
      loaded.push(...pageTasks);
      if (pageTasks.length < 100 || page >= result.meta.pagination.pages) break;
      page += 1;
    }
    tasks = loaded;
    render();
  }

  async function loadFriends() {
    const result = await api('/friends');
    friends = result.data.friends;
    friendRequests = result.data.requests;
    refreshTaskAssignees();
    renderFriends();
  }

  function updateDate() {
    const now = new Date();
    $('#dateLabel').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
    const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
    $('#greeting').textContent = `${greeting}, ${currentUser?.name.split(' ')[0] || 'friend'}.`;
  }

  function displayTaskName(task) {
    return task.createdById !== task.userId ? `Sent by ${findFriend(task.createdById)?.name || 'a friend'}` : '';
  }

  function findFriend(id) {
    return friends.find((friend) => friend.id === id);
  }

  function refreshTaskAssignees() {
    const select = $('#taskAssignee');
    const selected = select.value;
    select.replaceChildren(new Option('Just for me', ''));
    friends.forEach((friend) => select.add(new Option(`Send to ${friend.name}`, friend.id)));
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

  function setFriendMessage(message, isError = false) {
    const element = $('#friendMessage');
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  function makeFriendCard(user, status, actions = []) {
    const card = document.createElement('article');
    card.className = 'friend-card';
    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar';
    avatar.textContent = (user.name[0] || user.email[0]).toUpperCase();
    const details = document.createElement('div');
    details.className = 'friend-details';
    const name = document.createElement('div');
    name.className = 'friend-name';
    name.textContent = user.name;
    const email = document.createElement('div');
    email.className = 'friend-email';
    email.textContent = user.email;
    details.append(name, email);
    card.append(avatar, details);
    if (!actions.length) {
      const badge = document.createElement('span');
      badge.className = `friend-status${status === 'Invitation sent' ? ' pending' : ''}`;
      badge.textContent = status;
      card.append(badge);
      return card;
    }
    const actionGroup = document.createElement('div');
    actionGroup.className = 'friend-actions';
    actions.forEach(({ label, action, primary }) => {
      const button = document.createElement('button');
      button.className = `friend-action${primary ? ' primary' : ''}`;
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', action);
      actionGroup.append(button);
    });
    card.append(actionGroup);
    return card;
  }

  function renderFriends() {
    $('#friendsCount').textContent = friends.length;
    $('#friendsListCount').textContent = `${friends.length} connected`;
    const requestContainer = $('#friendRequests');
    requestContainer.replaceChildren();
    if (friendRequests.length) {
      const section = document.createElement('div');
      section.className = 'request-list';
      const title = document.createElement('h3');
      title.className = 'request-heading';
      title.textContent = 'Friend requests';
      section.append(title);
      friendRequests.forEach((request) => {
        const actions = request.direction === 'received' ? [
          { label: 'Accept', primary: true, action: () => decideFriendRequest(request, 'accept') },
          { label: 'Decline', action: () => decideFriendRequest(request, 'decline') }
        ] : [];
        section.append(makeFriendCard(request.user, request.direction === 'sent' ? 'Invitation sent' : 'Incoming request', actions));
      });
      requestContainer.append(section);
    }
    const list = $('#friendList');
    list.replaceChildren();
    const query = searchInput.value.trim().toLowerCase();
    const visibleFriends = friends.filter((friend) => `${friend.name} ${friend.email}`.toLowerCase().includes(query));
    visibleFriends.forEach((friend) => {
      const card = makeFriendCard(friend, 'Friend', [{
        label: 'Remove',
        action: () => removeFriend(friend)
      }]);
      list.append(card);
    });
    if (!visibleFriends.length) {
      const empty = document.createElement('div');
      empty.className = 'friends-empty';
      empty.textContent = friends.length ? 'No matching friends.' : friendRequests.some((request) => request.direction === 'received') ? 'Accept a request to connect and share tasks.' : 'No friends yet. Add someone by email to get started.';
      list.append(empty);
    }
    refreshTaskAssignees();
  }

  async function refreshSocial() {
    await loadFriends();
    if (activeFilter === 'chat') await loadChat(true);
  }

  $('#friendForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#friendForm').querySelector('button[type="submit"]');
    const email = $('#friendEmail').value.trim().toLowerCase();
    if (!$('#friendEmail').checkValidity()) {
      setFriendMessage('Enter a valid email address.', true);
      return;
    }
    startBusy(submit, 'Adding…');
    try {
      const result = await api('/friends/requests', { method: 'POST', body: JSON.stringify({ email }) });
      $('#friendForm').reset();
      setFriendMessage(result.data.request.status === 'accepted' ? `You and ${result.data.request.user.name} are now friends.` : `Invitation sent to ${result.data.request.user.email}.`);
      await refreshSocial();
    } catch (error) {
      setFriendMessage(error.message, true);
    } finally {
      stopBusy(submit);
    }
  });

  async function decideFriendRequest(request, action) {
    try {
      await api(`/friends/requests/${encodeURIComponent(request.id)}`, { method: 'PATCH', body: JSON.stringify({ action }) });
      setFriendMessage(action === 'accept' ? `You and ${request.user.name} are now friends.` : 'Friend request declined.');
      await refreshSocial();
    } catch (error) {
      setFriendMessage(error.message, true);
    }
  }

  async function removeFriend(friend) {
    if (!window.confirm(`Remove ${friend.name} from your friends?`)) return;
    try {
      await api(`/friends/${encodeURIComponent(friend.id)}`, { method: 'DELETE' });
      if (activeChatFriendId === friend.id) activeChatFriendId = '';
      setFriendMessage(`${friend.name} was removed.`);
      await refreshSocial();
    } catch (error) {
      setFriendMessage(error.message, true);
    }
  }

  function formatDueDate(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  function makeTaskElement(task, options = {}) {
    const dueDate = taskDateValue(task);
    const row = document.createElement('article');
    row.className = `task-row${task.completed ? ' done' : ''}`;
    const canDrag = (options.draggable ?? (activeFilter === 'all' && !searchInput.value.trim())) && !task.completed;
    row.draggable = canDrag;
    row.dataset.taskId = task.id;
    if (canDrag) {
      row.addEventListener('dragstart', (event) => {
        draggedTaskId = task.id;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.id);
      });
      row.addEventListener('dragend', () => {
        draggedTaskId = '';
        document.querySelectorAll('.task-row').forEach((item) => item.classList.remove('dragging', 'drag-over'));
      });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (draggedTaskId && draggedTaskId !== task.id) row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drag-over');
        const sourceId = event.dataTransfer.getData('text/plain') || draggedTaskId;
        if (sourceId && sourceId !== task.id) reorderTasks(sourceId, task.id, event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2);
      });
    }

    const check = document.createElement('button');
    check.className = 'task-check';
    check.type = 'button';
    check.setAttribute('aria-label', task.completed ? 'Mark task as not completed' : 'Mark task as completed');
    check.setAttribute('aria-pressed', String(Boolean(task.completed)));
    if (task.completed) check.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    check.addEventListener('click', () => toggleTask(task));

    const content = document.createElement('div');
    content.className = 'task-content';
    const name = document.createElement('div');
    name.className = 'task-name';
    name.textContent = task.title;
    content.append(name);
    if (task.description) {
      const description = document.createElement('div');
      description.className = 'task-meta';
      description.textContent = task.description;
      content.append(description);
    }
    if (dueDate) {
      const meta = document.createElement('div');
      meta.className = `task-meta${!task.completed && dueDate < localDateString() ? ' overdue' : ''}`;
      meta.textContent = `${!task.completed && dueDate < localDateString() ? 'Overdue · ' : 'Due '}${formatDueDate(dueDate)}`;
      content.append(meta);
    }
    const from = displayTaskName(task);
    if (from) {
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      meta.textContent = from;
      content.append(meta);
    }

    const tag = document.createElement('span');
    tag.className = `task-tag${task.priority === 'high' ? ' today' : ''}`;
    tag.textContent = task.completed ? 'DONE' : task.priority.toUpperCase();

    const edit = document.createElement('button');
    edit.className = 'edit-task';
    edit.type = 'button';
    edit.setAttribute('aria-label', `Edit task: ${task.title}`);
    edit.title = 'Edit task';
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5 5 5M4 20l4.2-.8L19 8a2.1 2.1 0 0 0-3-3L5.2 15.8 4 20Z"/></svg>';
    edit.addEventListener('click', () => openEditDialog(task));
    const remove = document.createElement('button');
    remove.className = 'delete-task';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete task: ${task.title}`);
    remove.title = 'Delete task';
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/></svg>';
    remove.addEventListener('click', () => deleteTask(task));
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (!task.completed && canDrag) {
      const moveUp = document.createElement('button');
      moveUp.className = 'move-task';
      moveUp.type = 'button';
      moveUp.setAttribute('aria-label', `Move ${task.title} up`);
      moveUp.title = 'Move up';
      moveUp.textContent = '↑';
      moveUp.addEventListener('click', () => moveTask(task.id, -1));
      const moveDown = document.createElement('button');
      moveDown.className = 'move-task';
      moveDown.type = 'button';
      moveDown.setAttribute('aria-label', `Move ${task.title} down`);
      moveDown.title = 'Move down';
      moveDown.textContent = '↓';
      moveDown.addEventListener('click', () => moveTask(task.id, 1));
      actions.append(moveUp, moveDown);
    }
    actions.append(edit, remove);
    row.append(check, content, tag, actions);
    return row;
  }

  function visibleTasks() {
    const today = localDateString();
    let result = tasks.filter((task) => {
      if (activeFilter === 'today') return !task.completed && taskDateValue(task) === today;
      if (activeFilter === 'upcoming') return !task.completed && taskDateValue(task) > today;
      if (activeFilter === 'completed') return task.completed;
      return !task.completed;
    });
    const query = searchInput.value.trim().toLowerCase();
    if (query) result = result.filter((task) => `${task.title} ${task.description || ''}`.toLowerCase().includes(query));
    return result.sort((a, b) => {
      if (activeFilter === 'all') return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt) - new Date(b.createdAt);
      if (a.dueDate && b.dueDate) return taskDateValue(a).localeCompare(taskDateValue(b)) || new Date(a.createdAt) - new Date(b.createdAt);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }

  function renderTaskList() {
    const displayed = visibleTasks();
    taskList.replaceChildren();
    if (displayed.length) {
      displayed.forEach((task) => taskList.append(makeTaskElement(task)));
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const heading = activeFilter === 'completed' ? 'Nothing completed just yet' : searchInput.value.trim() ? 'No matching tasks' : activeFilter === 'today' ? 'Nothing due today' : activeFilter === 'upcoming' ? 'Your future is open' : 'A clear page is a fresh start';
      const description = activeFilter === 'completed' ? 'Finished tasks will find their way here.' : searchInput.value.trim() ? 'Try another search, or add a new task.' : activeFilter === 'today' ? 'Add a task above and choose today as its due date.' : activeFilter === 'upcoming' ? 'Give a task a future due date to see it here.' : 'Add the first task you want to move forward.';
      empty.innerHTML = '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"/></svg></div>';
      const title = document.createElement('h3');
      title.textContent = heading;
      const text = document.createElement('p');
      text.textContent = description;
      empty.append(title, text);
      taskList.append(empty);
    }
  }

  function render() {
    if (!currentUser) return;
    const completed = tasks.filter((task) => task.completed).length;
    const remaining = tasks.length - completed;
    $('#allCount').textContent = remaining;
    $('#completedCount').textContent = completed;
    const progress = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
    $('#progressText').textContent = `${progress}%`;
    $('#progressFill').style.width = `${progress}%`;
    $('#progressCaption').textContent = tasks.length ? `${completed} of ${tasks.length} tasks completed.` : 'A good day starts with one task.';
    $('#summary').textContent = remaining === 0 ? 'You’re all caught up. Enjoy the breathing room.' : `${remaining} ${remaining === 1 ? 'task' : 'tasks'} to go. You’ve got this.`;

    const titles = { all: 'All tasks', today: 'Today', upcoming: 'Upcoming', completed: 'Completed', friends: 'Friends', calendar: 'Calendar', chat: 'Chat' };
    $('#listTitle').textContent = titles[activeFilter];
    friendsView = activeFilter === 'friends';
    const isCalendar = activeFilter === 'calendar';
    const isChat = activeFilter === 'chat';
    friendsPanel.classList.toggle('hidden', !friendsView);
    calendarPanel.classList.toggle('hidden', !isCalendar);
    chatPanel.classList.toggle('hidden', !isChat);
    tasksSection.classList.toggle('hidden', friendsView || isCalendar || isChat);
    taskForm.classList.toggle('hidden', friendsView || isChat);
    searchInput.placeholder = friendsView ? 'Find a friend...' : 'Find a task...';
    document.querySelectorAll('.nav-item').forEach((button) => {
      const selected = button.dataset.filter === activeFilter;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    if (friendsView) {
      renderFriends();
      $('#clearCompleted').classList.add('hidden');
      stopChatPolling();
      return;
    }
    if (isCalendar) {
      taskDate.value = selectedCalendarDate;
      renderCalendar();
      $('#clearCompleted').classList.add('hidden');
      stopChatPolling();
      return;
    }
    if (isChat) {
      renderChat();
      $('#clearCompleted').classList.add('hidden');
      startChatPolling();
      return;
    }
    renderTaskList();
    $('#clearCompleted').classList.toggle('hidden', completed === 0);
    stopChatPolling();
  }

  async function toggleTask(task) {
    try {
      const result = await api(`/tasks/${encodeURIComponent(task.id)}/toggle`, { method: 'PATCH' });
      tasks = tasks.map((item) => item.id === task.id ? result.data.task : item);
      setAppMessage('Task updated.');
      render();
    } catch (error) {
      setAppMessage(error.message, true);
    }
  }

  async function deleteTask(task) {
    try {
      await api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      tasks = tasks.filter((item) => item.id !== task.id);
      setAppMessage('Task deleted.');
      render();
    } catch (error) {
      setAppMessage(error.message, true);
    }
  }

  function openEditDialog(task) {
    $('#editTaskId').value = task.id;
    $('#editTaskTitle').value = task.title;
    $('#editTaskDescription').value = task.description || '';
    $('#editTaskDate').value = taskDateValue(task);
    $('#editTaskPriority').value = task.priority;
    $('#editTaskDialog').showModal();
    $('#editTaskTitle').focus();
  }

  function closeEditDialog() {
    $('#editTaskDialog').close();
  }

  $('#editTaskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#editTaskForm').querySelector('button[type="submit"]');
    const id = $('#editTaskId').value;
    const title = $('#editTaskTitle').value.trim();
    if (!title) return;
    startBusy(submit, 'Saving…');
    try {
      const result = await api(`/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          description: $('#editTaskDescription').value.trim() || null,
          dueDate: $('#editTaskDate').value || null,
          priority: $('#editTaskPriority').value
        })
      });
      tasks = tasks.map((task) => task.id === id ? result.data.task : task);
      closeEditDialog();
      setAppMessage('Changes saved.');
      render();
    } catch (error) {
      setAppMessage(error.message, true);
    } finally {
      stopBusy(submit);
    }
  });
  $('#closeEditDialog').addEventListener('click', closeEditDialog);
  $('#cancelEdit').addEventListener('click', closeEditDialog);
  $('#editTaskDialog').addEventListener('click', (event) => {
    if (event.target === $('#editTaskDialog')) closeEditDialog();
  });

  async function reorderTasks(sourceId, targetId, afterTarget) {
    const ordered = tasks.filter((task) => !task.completed).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt) - new Date(b.createdAt));
    const sourceIndex = ordered.findIndex((task) => task.id === sourceId);
    if (sourceIndex < 0) return;
    const [moved] = ordered.splice(sourceIndex, 1);
    const targetIndex = ordered.findIndex((task) => task.id === targetId);
    if (targetIndex < 0) return;
    ordered.splice(targetIndex + (afterTarget ? 1 : 0), 0, moved);
    ordered.forEach((task, index) => { task.sortOrder = index; });
    tasks = [...ordered, ...tasks.filter((task) => task.completed)];
    render();
    try {
      await Promise.all(ordered.map((task) => api(`/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH', body: JSON.stringify({ sortOrder: task.sortOrder })
      })));
      setAppMessage('Task order saved.');
    } catch (error) {
      setAppMessage(`Could not save task order: ${error.message}`, true);
      await loadTasks();
    }
  }

  async function moveTask(taskId, direction) {
    const ordered = tasks.filter((task) => !task.completed).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt) - new Date(b.createdAt));
    const index = ordered.findIndex((task) => task.id === taskId);
    const target = ordered[index + direction];
    if (index < 0 || !target) return;
    await reorderTasks(taskId, target.id, direction > 0);
  }

  $('#taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = taskInput.value.trim();
    if (!title) return taskInput.focus();
    const assignedToId = $('#taskAssignee').value;
    const sortOrder = tasks.reduce((maximum, task) => Math.max(maximum, task.sortOrder ?? 0), -1) + 1;
    const body = {
      title,
      dueDate: taskDate.value || null,
      priority: $('#taskPriority').value,
      sortOrder,
      ...(assignedToId ? { assignedToId } : {})
    };
    const submit = taskForm.querySelector('button[type="submit"]');
    startBusy(submit, assignedToId ? 'Sending…' : 'Adding…');
    try {
      const result = await api('/tasks', { method: 'POST', body: JSON.stringify(body) });
      if (assignedToId) {
        const friend = findFriend(assignedToId);
        setAppMessage(`Task sent to ${friend?.name || 'your friend'}; it appears in their list only.`);
      } else {
        tasks.push(result.data.task);
        setAppMessage('Task added.');
      }
      taskForm.reset();
      if (activeFilter === 'calendar') taskDate.value = selectedCalendarDate;
      else if (activeFilter !== 'all') activeFilter = 'all';
      render();
      taskInput.focus();
    } catch (error) {
      setAppMessage(error.message, true);
    } finally {
      stopBusy(submit);
    }
  });

  $('#clearCompleted').addEventListener('click', async () => {
    const completed = tasks.filter((task) => task.completed);
    if (!completed.length) return;
    const button = $('#clearCompleted');
    startBusy(button, 'Clearing…');
    try {
      const outcomes = await Promise.allSettled(completed.map((task) => api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' })));
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
      await loadTasks();
      setAppMessage(failed.length ? `${failed.length} completed task(s) could not be deleted.` : 'Completed tasks cleared.', Boolean(failed.length));
    } catch (error) {
      setAppMessage(error.message, true);
    } finally {
      stopBusy(button);
      render();
    }
  });

  function renderCalendar() {
    $('#calendarMonth').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarMonth);
    const grid = $('#calendarGrid');
    grid.replaceChildren();
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((day) => {
      const label = document.createElement('div');
      label.className = 'calendar-weekday';
      label.setAttribute('role', 'columnheader');
      label.textContent = day;
      grid.append(label);
    });
    const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    const today = localDateString();
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = localDateString(date);
      const dayTasks = tasks.filter((task) => taskDateValue(task) === key);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `calendar-cell${date.getMonth() !== calendarMonth.getMonth() ? ' outside' : ''}${key === selectedCalendarDate ? ' selected' : ''}${key === today ? ' today' : ''}`;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(date)}${dayTasks.length ? `, ${dayTasks.length} ${dayTasks.length === 1 ? 'task' : 'tasks'}` : ''}`);
      if (key === selectedCalendarDate) cell.setAttribute('aria-pressed', 'true');
      const number = document.createElement('span');
      number.className = 'calendar-date';
      number.textContent = String(date.getDate());
      const dots = document.createElement('span');
      dots.className = 'calendar-dots';
      dayTasks.slice(0, 4).forEach((task) => {
        const dot = document.createElement('span');
        if (task.completed) dot.className = 'completed-dot';
        dots.append(dot);
      });
      cell.append(number, dots);
      cell.addEventListener('click', () => {
        selectedCalendarDate = key;
        calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        taskDate.value = key;
        renderCalendar();
      });
      grid.append(cell);
    }
    const selectedDate = new Date(`${selectedCalendarDate}T00:00:00`);
    $('#calendarDayTitle').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(selectedDate);
    const dayTasks = tasks.filter((task) => taskDateValue(task) === selectedCalendarDate).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    $('#calendarTaskCount').textContent = `${dayTasks.length} ${dayTasks.length === 1 ? 'task' : 'tasks'}`;
    const list = $('#calendarDayTasks');
    list.replaceChildren();
    if (dayTasks.length) dayTasks.forEach((task) => list.append(makeTaskElement(task, { draggable: false })));
    else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const heading = document.createElement('h3');
      heading.textContent = 'Nothing planned for this day';
      const text = document.createElement('p');
      text.textContent = 'Add a task above and select this date to put it on your calendar.';
      empty.append(heading, text);
      list.append(empty);
    }
  }

  $('#previousMonth').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    selectedCalendarDate = localDateString(calendarMonth);
    taskDate.value = selectedCalendarDate;
    renderCalendar();
  });
  $('#nextMonth').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    selectedCalendarDate = localDateString(calendarMonth);
    taskDate.value = selectedCalendarDate;
    renderCalendar();
  });
  $('#calendarToday').addEventListener('click', () => {
    selectedCalendarDate = localDateString();
    calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    taskDate.value = selectedCalendarDate;
    renderCalendar();
  });

  function renderChat() {
    const strip = $('#chatFriendList');
    strip.replaceChildren();
    if (!friends.some((friend) => friend.id === activeChatFriendId)) activeChatFriendId = friends[0]?.id || '';
    friends.forEach((friend) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chat-friend${friend.id === activeChatFriendId ? ' active' : ''}`;
      button.textContent = friend.name;
      button.setAttribute('aria-pressed', String(friend.id === activeChatFriendId));
      button.addEventListener('click', async () => {
        activeChatFriendId = friend.id;
        chatMessages = [];
        renderChat();
        await loadChat();
      });
      strip.append(button);
    });
    const thread = $('#chatThread');
    thread.replaceChildren();
    const input = $('#chatInput');
    const sendButton = $('#chatForm').querySelector('button[type="submit"]');
    input.disabled = !activeChatFriendId;
    sendButton.disabled = !activeChatFriendId;
    if (!activeChatFriendId) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = 'Add and accept a friend connection before starting a chat.';
      thread.append(empty);
      return;
    }
    if (!chatMessages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = `Say hello to ${findFriend(activeChatFriendId)?.name || 'your friend'}.`;
      thread.append(empty);
    }
    chatMessages.forEach((message) => {
      const bubble = document.createElement('div');
      const mine = message.sender.id === currentUser.id;
      bubble.className = `chat-message${mine ? ' mine' : ''}${message.taskId ? ' task-message' : ''}`;
      bubble.textContent = message.body;
      const meta = document.createElement('span');
      meta.className = 'chat-message-meta';
      meta.textContent = `${mine ? 'You' : message.sender.name} · ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(message.createdAt))}`;
      bubble.append(meta);
      thread.append(bubble);
    });
    thread.scrollTop = thread.scrollHeight;
  }

  async function loadChat(quiet = false) {
    if (!activeChatFriendId || activeFilter !== 'chat') return;
    try {
      const response = await api(`/friends/${encodeURIComponent(activeChatFriendId)}/messages?page=1&limit=100`);
      const incoming = response.data.messages;
      const latestId = chatMessages.at(-1)?.id;
      chatMessages = incoming;
      renderChat();
      if (!quiet && incoming.at(-1)?.id !== latestId) setAppMessage('Chat updated.');
    } catch (error) {
      if (!quiet) setAppMessage(error.message, true);
    }
  }

  function startChatPolling() {
    if (chatPollTimer || !activeChatFriendId) return;
    chatPollTimer = window.setInterval(() => loadChat(true), 5000);
  }

  function stopChatPolling() {
    if (chatPollTimer) window.clearInterval(chatPollTimer);
    chatPollTimer = null;
  }

  $('#chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = $('#chatInput').value.trim();
    if (!body || !activeChatFriendId) return;
    const submit = $('#chatForm').querySelector('button[type="submit"]');
    startBusy(submit, 'Sending…');
    try {
      await api(`/friends/${encodeURIComponent(activeChatFriendId)}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      $('#chatInput').value = '';
      await loadChat(true);
    } catch (error) {
      setAppMessage(error.message, true);
    } finally {
      stopBusy(submit);
    }
  });

  $('#searchInput').addEventListener('input', () => {
    if (friendsView) renderFriends();
    else if (activeFilter === 'calendar') renderCalendar();
    else if (activeFilter !== 'chat') renderTaskList();
  });

  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', async () => {
    activeFilter = button.dataset.filter;
    searchInput.value = '';
    if (activeFilter === 'calendar') taskDate.value = selectedCalendarDate;
    render();
    if (activeFilter === 'chat' && activeChatFriendId) await loadChat();
  }));

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (error) {
      if (error.status !== 401) setAppMessage(error.message, true);
    }
    showSignedOut('You have signed out.');
  }
  $('#logoutButton').addEventListener('click', signOut);
  $('#headerLogout').addEventListener('click', signOut);

  $('#deleteAccountButton').addEventListener('click', async () => {
    if (!window.confirm('Permanently delete your account, tasks, friendships, and chat messages? This cannot be undone.')) return;
    const password = window.prompt('Confirm your password to delete the account:');
    if (password === null) return;
    try {
      await api('/auth/me', { method: 'DELETE', body: JSON.stringify({ password }) });
      showSignedOut('Your account and associated data were deleted.');
    } catch (error) {
      setAppMessage(error.message, true);
    }
  });

  window.addEventListener('focus', () => {
    if (!currentUser) return;
    loadTasks().catch((error) => setAppMessage(error.message, true));
    loadFriends().catch((error) => setAppMessage(error.message, true));
  });

  async function boot() {
    if (!API_BASE_URL) {
      authMessage.textContent = 'Open this page through a local web server (not file://), then start the backend with npm start from the project folder.';
      return;
    }
    const query = new URLSearchParams(location.search);
    const verificationToken = query.get('verify');
    const resetToken = query.get('reset');
    let verifiedNow = false;
    if (verificationToken) {
      authMessage.textContent = 'Verifying your email…';
      try {
        await api(`/auth/verify-email?token=${encodeURIComponent(verificationToken)}`);
        authMessage.textContent = 'Email verified. You can now sign in.';
        verifiedNow = true;
      } catch (error) {
        authMessage.textContent = error.message;
      } finally {
        history.replaceState({}, '', `${location.pathname}${location.hash}`);
      }
    } else if (query.has('verified')) {
      authMessage.textContent = 'Email verified. You can now sign in.';
      verifiedNow = true;
      history.replaceState({}, '', `${location.pathname}${location.hash}`);
    }
    if (verifiedNow) return;
    if (resetToken) {
      $('#resetToken').value = resetToken;
      authForm.classList.add('hidden');
      $('#recoveryForm').classList.add('hidden');
      $('#resetPasswordForm').classList.remove('hidden');
      $('#newPassword').focus();
      return;
    }
    try {
      const result = await api('/auth/session');
      if (result.data.user) await openWorkspace(result.data.user);
    } catch (error) {
      if (error.status !== 401) authMessage.textContent = error.message;
    }
  }

  window.addEventListener('error', (event) => {
    if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) {
      apiError.textContent = `Could not load a frontend asset: ${event.target.getAttribute('src') || event.target.getAttribute('href') || 'unknown file'}`;
    }
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    apiError.textContent = event.reason instanceof Error ? event.reason.message : 'An unexpected app error occurred.';
  });

  setAuthMode(false);
  boot();
})();
