'use strict';
'require view';
'require rpc';
'require poll';
'require dom';
'require ui';
'require view.roamd.common as common';
'require uci';

var nodeUiOpen = false;
var clientFocus = '';
var meshActivate = function() {};
var refreshClients = function() {};
var nodesView = 'cards';
var mapShowClients = true;
var mapClientCache = null;
var mapClientSeq = 0;
var meshViewState = null;
var mapCam = { x: 0, y: 0, k: 1, sig: null, user: false, w: 0, h: 0 };
var mapBindSeq = 0;
var mapObserver = null;
var mapLive = { macs: {}, bytes: {} };

function locationHash() {
	try {
		return String(location.hash || '').replace(/^#/, '');
	} catch (e) {
		return '';
	}
}

function openClients(nodeId) {
	clientFocus = nodeId || '';

	try {
		location.hash = clientFocus ? 'clients/' + encodeURIComponent(clientFocus) : 'clients';
	} catch (e) {}

	meshActivate('clients');
	refreshClients();
}

var callRoamingStatus = rpc.declare({
	object: 'roamd',
	method: 'status',
	expect: { '': {} }
});

function meshStatusWithRoaming() {
	return Promise.all([
		common.meshStatus(),
		callRoamingStatus().catch(function() { return null; })
	]).then(function(results) {
		var state = results[0] || {};
		state.controller_roaming = results[1];
		return state;
	});
}

var callMeshClients = rpc.declare({
	object: 'roamd',
	method: 'mesh_clients',
	expect: { clients: [] }
});

var callMeshSelfCheck = rpc.declare({
	object: 'roamd',
	method: 'mesh_self_check',
	params: [ 'start', 'stop' ],
	expect: { }
});

var callMeshClientForget = rpc.declare({
	object: 'roamd',
	method: 'mesh_client_forget',
	params: [ 'mac' ],
	expect: { }
});

var callMeshClientUpdate = rpc.declare({
	object: 'roamd',
	method: 'mesh_client_update',
	params: [ 'mac', 'band', 'alias', 'nodes' ],
	expect: { }
});

var callMeshDiscover = rpc.declare({
	object: 'roamd',
	method: 'mesh_discover',
	params: [ 'start', 'stop' ],
	expect: { }
});

var callMeshAcquire = rpc.declare({
	object: 'roamd',
	method: 'mesh_acquire',
	params: [ 'addr', 'reset' ],
	expect: { }
});

var callMeshAcquireStatus = rpc.declare({
	object: 'roamd',
	method: 'mesh_acquire_status',
	params: [ 'task_id' ],
	expect: { }
});

var callMeshMemberRemove = rpc.declare({
	object: 'roamd',
	method: 'mesh_member_remove',
	params: [ 'id', 'reset' ],
	expect: { }
});

var callMeshLog = rpc.declare({
	object: 'roamd',
	method: 'mesh_log',
	expect: { events: [] }
});

var callMeshUpdate = rpc.declare({
	object: 'roamd',
	method: 'mesh_update',
	params: [ 'id' ],
	expect: { }
});

var callMeshSelfUpdate = rpc.declare({
	object: 'roamd',
	method: 'mesh_self_update',
	expect: { }
});

var callMeshMemberUpdate = rpc.declare({
	object: 'roamd',
	method: 'mesh_member_update',
	params: [ 'id', 'name', 'nodes' ],
	expect: { }
});

var callMeshSettings = rpc.declare({
	object: 'roamd',
	method: 'mesh_settings',
	params: [ 'backhaul_enabled', 'backhaul_ssid', 'backhaul_key', 'wifi_shutdown', 'node_ui',
		'backhaul_delta', 'backhaul_min_signal', 'auto_update', 'auto_update_every',
		'auto_update_unit', 'pkg_url' ],
	expect: { }
});

var callMeshNetworkUpdate = rpc.declare({
	object: 'roamd',
	method: 'mesh_network_update',
	params: [ 'ssid', 'roaming' ],
	expect: { }
});

var callMeshControllerName = rpc.declare({
	object: 'roamd',
	method: 'mesh_settings',
	params: [ 'controller_name' ],
	expect: { }
});

var EVENT_TYPE = {
	connect: _('connected'),
	disconnect: _('disconnected'),
	roam: _('roaming'),
	steer: _('steering'),
	kick: _('forced disconnect'),
	'deny-node': _('device not allowed'),
	'deny-band': _('band not allowed')
};

var CLIENT_STATE = {
	online: { color: '#2e9e2e', label: _('online') },
	unknown: { color: '#e0a800', label: _('node not responding') },
	offline: { color: '#bbb', label: _('offline') }
};

function clientState(c) {
	return CLIENT_STATE[c.state] || CLIENT_STATE.offline;
}

function clientSeen(c) {
	return c.state !== 'offline';
}

var ISSUE_TEXT = {
	ssid: _('SSID differs'),
	encryption: _('encryption differs'),
	mobility_domain: _('mobility domain differs'),
	ieee80211r: _('802.11r differs')
};

var nodeNames = {};

function nodeTitle(node) {
	if (!node || node === 'controller')
		return nodeNames.controller || _('controller');

	return nodeNames[node] || node;
}

function nodeLabel(node, band) {
	var name = nodeTitle(node);
	return band ? '%s · %s'.format(name, common.bandLabel(band)) : name;
}

function nodeCell(node, band) {
	if (!node && !band)
		return '-';

	var bandNode = band ? common.bandLabel(band) : '';

	return common.twoLine(E('span', {}, nodeTitle(node)), bandNode);
}

function timeCell(ts) {
	var d = new Date((ts || 0) * 1000);

	return common.twoLine(E('span', {}, d.toLocaleTimeString()), d.toLocaleDateString());
}

var logNames = {};

function clientCell(mac) {
	return common.macCell(logNames[(mac || '').toLowerCase()], mac);
}

function logItem(ev) {
	return E('article', { 'class': 'roamd-event' }, [
		E('div', { 'class': 'roamd-event-meta' }, [
			E('div', { 'class': 'roamd-event-time' }, timeCell(ev.ts)),
			E('div', { 'class': 'roamd-event-type' }, EVENT_TYPE[ev.type] || ev.type || '')
		]),
		E('div', { 'class': 'roamd-event-who' }, clientCell(ev.mac)),
		E('div', { 'class': 'roamd-route' }, [
			E('span', { 'class': 'roamd-k' }, _('From')),
			nodeCell(ev.from_node, ev.from_band),
			E('span', { 'class': 'roamd-arrow' }, '→'),
			E('span', { 'class': 'roamd-k' }, _('To')),
			nodeCell(ev.to_node, ev.to_band)
		])
	]);
}

function logCsv(events) {
	var head = [ 'time', 'client', 'from', 'to', 'type' ];
	var rows = events.map(function(ev) {
		return [ new Date((ev.ts || 0) * 1000).toISOString(), ev.mac || '',
			nodeLabel(ev.from_node, ev.from_band), nodeLabel(ev.to_node, ev.to_band),
			ev.type || '' ];
	});

	return [ head ].concat(rows).map(function(r) {
		return r.map(function(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
	}).join('\n');
}

function downloadCsv(events) {
	var blob = new Blob([ logCsv(events) ], { type: 'text/csv' });
	var url = URL.createObjectURL(blob);
	var a = E('a', { 'href': url, 'download': 'mesh-transitions.csv' });

	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

var ACQUIRE_ERR = {
	spawn_failed: _('Could not start the capture task.'),
	busy: _('A capture is already in progress.'),
	no_such_task: _('The capture task is gone.'),
	no_address: _('No device address given.')
};

var ACQUIRE_ORDER = [ 'reset', 'probe', 'install', 'enroll', 'network', 'profile', 'done' ];

var ACQUIRE_MSG = [
	[ /^updating roamd on the node$/, function() { return _('installing roamd on the node'); } ],
	[ /^updated$/, function() { return _('the node is up to date'); } ],
	[ /^checking the repository$/, function() { return _('asking the repository'); } ],
	[ /^the controller is updated$/, function() { return _('the controller is updated'); } ],
	[ /^update installed$/, function() { return _('the update is installed'); } ],
	[ /^no updates$/, function() { return _('no updates available'); } ],
	[ /^some nodes were not updated$/, function() { return _('some nodes were not updated'); } ],
	[ /^node is unreachable$/, function() { return _('the node is unreachable'); } ],
	[ /^resetting the device to factory settings$/, function() { return _('resetting the device to factory settings'); } ],
	[ /^waiting for the device to come back after the reset$/, function() { return _('waiting for the device to come back'); } ],
	[ /^the device is reset to factory settings and back online$/, function() { return _('the device is reset and back online'); } ],
	[ /^the reset is skipped by the user$/, function() { return _('the reset is skipped by the user'); } ],
	[ /^unknown OpenWrt version or architecture$/, function() { return _('unknown OpenWrt version or architecture'); } ],
	[ /^no package for the OpenWrt version of the node$/, function() { return _('no package for the OpenWrt version of the node'); } ],
	[ /^package installation failed on the node$/, function() { return _('the package could not be installed on the node'); } ],
	[ /^package source is not trusted: .*$/, function() { return _('the package source is not trusted: the repository must be https and its certificate must be in /etc/roamd/pkg.crt'); } ],
	[ /^installing roamd and interface for (.+)$/, function(m) { return _('packages for OpenWrt %s').format(m[1]); } ],
	[ /^repository unreachable, installed from the controller cache$/, function() { return _('repository unreachable, installed from the cache'); } ],
	[ /^checking what the node needs from the OpenWrt feeds$/, function() { return _('checking what the node needs from the OpenWrt repositories'); } ],
	[ /^cannot ask the node which packages it needs$/, function() { return _('the node did not report which packages it needs'); } ],
	[ /^(\S+) is part of the device firmware and conflicts with roamd — it cannot be captured$/, function(m) { return _('%s is built into the firmware of this device and conflicts with roamd: such a device cannot become a node').format(m[1]); } ],
	[ /^the node needs (.+) but has no OpenWrt package feeds — capture stopped before the node was changed$/, function(m) { return _('the node needs %s, but it has no OpenWrt package repositories; capture stopped before any change to the node').format(m[1]); } ],
	[ /^the node needs (.+) from (\S+), which the controller cannot reach — capture stopped$/, function(m) { return _('the node needs %s from %s, but the controller cannot reach it; capture stopped before any change to the node').format(m[1], m[2]); } ],
	[ /^the node at (\S+) is still a router \((.+)\) — single subnet$/, function(m) { return _('the node at %s is still a router (%s): the single subnet was not applied').format(m[1], m[2]); } ],
	[ /^assigning node role$/, function() { return _('assigning the node role'); } ],
	[ /^switching the node to the controller subnet$/, function() { return _('switching to the controller subnet'); } ],
	[ /^checking 802.11v support on the node$/, function() { return _('checking 802.11v support'); } ],
	[ /^waiting for the node to broadcast the network$/, function() { return _('waiting for the network to go on air'); } ],
	[ /^the node broadcasts the network on (\d+) radio\(s\)$/, function(m) { return _('the network is on air on %s radio(s)').format(m[1]); } ],
	[ /^securing the control channel$/, function() { return _('securing the control channel'); } ],
	[ /^installing service key$/, function() { return _('installing the service key'); } ],
	[ /^service key works, password login disabled on the node$/, function() { return _('service key works, password login disabled'); } ],
	[ /^key login does not work, the node restores password login by itself in 90s$/, function() { return _('key login failed, the node restores password login itself'); } ],
	[ /^service key was not installed, password login left enabled on the node$/, function() { return _('service key was not installed, password login left enabled'); } ],
	[ /^resetting the node to factory settings$/, function() { return _('resetting the device to factory settings'); } ],
	[ /^the node is resetting to factory settings$/, function() { return _('the device is resetting to factory settings'); } ],
	[ /^the node did not accept the reset, release it manually$/, function() { return _('the device did not accept the reset — reset it manually'); } ],
	[ /^the node is still reachable, the reset may have failed$/, function() { return _('the device still answers — the reset may have failed'); } ],
	[ /^the node is not in the system$/, function() { return _('the device is not in the system'); } ],
	[ /^installing packages on the controller$/, function() { return _('installing the packages'); } ],
	[ /^package index is not available$/, function() { return _('the package index is not available'); } ],
	[ /^package installation failed$/, function() { return _('the packages could not be installed'); } ],
	[ /^deps: (.+)$/, function(m) { return m[1]; } ]
];

function acquireMsgText(msg) {
	if (!msg)
		return '';

	for (var i = 0; i < ACQUIRE_MSG.length; i++) {
		var m = ACQUIRE_MSG[i][0].exec(msg);

		if (m)
			return ACQUIRE_MSG[i][1](m);
	}

	return msg;
}

var ACQUIRE_STEP = {
	check: _('checking for updates'),
	probe: _('checking the device'),
	reset: _('resetting the device'),
	update: _('updating packages'),
	compat: _('compatibility'),
	install: _('installing packages'),
	network: _('switching to the single subnet'),
	profile: _('rolling out the profile'),
	enroll: _('enrolling the node'),
	done: _('finished')
};

function acquireErrText(msg) {
	return ACQUIRE_ERR[msg] || msg;
}

function acquireStepText(step) {
	return ACQUIRE_STEP[step] || step;
}

var JOB_POLL_INTERVAL = 3000;
var SELF_CHECK_LIMIT = 300000;

function runJob(call, limit, done) {
	var open = true;
	var deadline = Date.now() + limit;

	var fail = function() {
		call(false, true);
		done(null);
	};

	var tick = function(start) {
		call(start).then(function(res) {
			if (!open)
				return;

			res = res || {};

			if (!res.running)
				done(res);
			else if (Date.now() < deadline)
				window.setTimeout(function() { tick(false); }, JOB_POLL_INTERVAL);
			else
				fail();
		}, function() {
			if (open)
				fail();
		});
	};

	tick(true);

	return function() {
		open = false;
		ui.hideModal();
		call(false, true);
	};
}

function discoverDialog() {
	var wrap = E('div', {});
	var cancel = function() { ui.hideModal(); };

	function help() {
		dom.content(wrap, [
			E('p', {}, _('To add a node: reset the new device to factory settings and make sure it has no administrator password.')),
			E('p', {}, E('strong', {}, _('Connect a LAN port of the controller to a LAN port of the new device — not to its WAN port.'))),
			E('p', { 'class': 'cbi-value-description' }, _('The controller needs root access to the device: SSH on port 22 without a password and, if the device has LuCI, port 80 open. Firmware where the root login is disabled or password-protected cannot be captured.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': scan }, _('Scan'))
			])
		]);
	}

	function scan() {
		dom.content(wrap, [
			E('p', { 'class': 'spinning' }, _('Scanning the local network…')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': function() { cancel(); } }, _('Close'))
			])
		]);

		cancel = runJob(callMeshDiscover, Infinity, function(res) {
			if (!res) {
				dom.content(wrap, E('p', { 'class': 'alert-message warning' }, _('Could not scan the local network.')));
				return;
			}

			var list = res.candidates || [];

			if (!list.length) {
				dom.content(wrap, E('p', {}, _('No devices found. Reset the new device to factory settings and make sure it has no password, then try again.')));
				return;
			}

			dom.content(wrap, list.map(renderCandidate));
		});
	}

	common.showModal(_('Add a new node'), [ wrap ]);
	help();
}

var PKG_STATE_TEXT = {
	conflict: _('%s is installed on the device: it also manages roaming and would interfere with roamd. The factory reset before the capture removes it, unless it is built into the firmware'),
	missing: _('OpenWrt %s (%s) is not supported: the repository has no roamd package for this version and architecture'),
	unreachable: _('Could not check for the roamd package for OpenWrt %s (%s): the package repository is unreachable. Check the internet access of the controller and search again')
};

function renderCandidate(c) {
	var ready = c.pkg === 'ready';
	var lines = [
		E('strong', {}, c.name || c.addr),
		E('br'),
		E('small', {}, '%s · %s · %s · OpenWrt %s'.format(c.addr, c.mac, c.model || '?', c.os || '?'))
	];

	if (!ready)
		lines.push(E('div', { 'style': 'color:#c33' }, E('small', {},
			PKG_STATE_TEXT[c.pkg].format(c.os || '?', c.arch || '?'))));

	if (c.conflict)
		lines.push(E('div', { 'style': 'color:#c60' }, E('small', {},
			PKG_STATE_TEXT.conflict.format(c.conflict))));

	var action = E('button', {
		'class': 'btn cbi-button cbi-button-action',
		'disabled': ready ? null : 'disabled',
		'click': function(ev) { confirmAcquire(c, ev.target); }
	}, _('Capture'));

	return E('div', { 'class': 'cbi-section roamd-candidate' },
		[ E('div', {}, lines), action ]);
}

function confirmAcquire(c, button) {
	var label = c.name && c.name !== 'OpenWrt' ? c.name : (c.model || c.addr);
	var skip = E('input', { 'type': 'checkbox' });

	common.showModal(_('The device will be reset to factory settings'), [
		E('p', {}, _('Before capture, %s (%s) is reset to factory settings. Everything configured on it — networks, passwords, packages, firewall rules — is erased.').format(label, c.mac)),
		E('p', {}, _('This is needed so the node starts from a known state: the controller rolls out the whole configuration itself, and leftovers from previous setups are the usual reason a capture breaks halfway.')),
		E('p', {}, E('strong', { 'style': 'color:#c33' },
			_('Do not capture a device that has to keep working as a router: a node has no own network settings, it only broadcasts the networks of the Wi-Fi system.'))),
		E('p', { 'class': 'cbi-value-description' },
			_('The device will reboot and come back on its own — that takes a few minutes.')),
		E('div', { 'class': 'cbi-value' },
			E('label', {}, [ skip, ' ',
				_('I understand the risks and want to skip the reset') ])),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-negative',
				'click': function() {
					ui.hideModal();
					startAcquire(c.addr, button, !skip.checked);
				}
			}, _('Continue'))
		])
	]);
}

function startAcquire(addr, button, reset) {
	var body = E('div', {}, [ E('p', { 'class': 'spinning' }, _('Capturing %s…').format(addr)) ]);

	if (button)
		button.disabled = true;

	common.showModal(_('Capturing the node'), [ body ]);

	callMeshAcquire(addr, reset === false ? '0' : '1').then(function(res) {
		res = res || {};

		if (res.error && !res.task_id) {
			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, acquireErrText(res.error)),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			return;
		}

		if (res.error === 'busy')
			dom.content(body, E('p', {}, _('This node is already being captured, showing the progress.')));

		pollAcquire(res.task_id, body, 0, 'acquire');
	});
}

function acquireProgress(steps, kind) {
	var state = {};
	var first = steps.length ? steps[0].step : null;
	var order = kind === 'release' ? [ 'reset', 'done' ]
		: (kind === 'autoupdate' || first === 'check') ? [ 'check', 'update', 'done' ]
		: (kind === 'update' || kind === 'selfupdate' || first === 'update') ? [ 'update', 'done' ]
		: ACQUIRE_ORDER.slice();
	var reached = -1;
	var failed = null;

	steps.forEach(function(s) {
		if (order.indexOf(s.step) < 0)
			order.splice(order.length - 1, 0, s.step);

		state[s.step] = s;

		if (s.status === 'error')
			failed = s.step;

		var i = order.indexOf(s.step);
		if (i > reached)
			reached = i;
	});

	return order.map(function(step, i) {
		var s = state[step] || {};
		var done = s.status === 'ok' || (state[step] && i < reached && s.status !== 'error');
		var mark = s.status === 'error' ? '✕' : (done ? '✓' : (i === reached ? '·' : '·'));
		var text;

		if (s.status === 'error')
			text = acquireErrText(acquireMsgText(s.message));
		else if (!state[step])
			text = _('waiting');
		else if (done && step === 'done')
			text = kind === 'autoupdate' ? acquireMsgText(s.message)
				: kind === 'selfupdate' ? _('the controller is up to date')
				: (kind === 'update' || s.message === 'updated') ? _('the node is up to date')
				: kind === 'release' ? _('the device is released')
				: _('the node is part of the system');
		else
			text = acquireMsgText(s.message) || (done ? _('done') : _('in progress'));

		return E('div', {
			'style': s.status === 'error' ? 'color:#c33'
				: (state[step] ? '' : 'color:#999')
		}, '%s %s — %s'.format(mark, acquireStepText(step), text));
	});
}

function pollAcquire(task, body, misses, kind) {
	callMeshAcquireStatus(task).then(function(res) {
		res = res || {};

		if (res.error) {
			if ((misses || 0) < 10) {
				window.setTimeout(function() { pollAcquire(task, body, (misses || 0) + 1, kind); }, 2000);
				return;
			}

			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, acquireErrText(res.error)),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); location.reload(); } }, _('Close')))
			]);
			return;
		}

		var steps = res.steps || [];
		var last = steps[steps.length - 1] || {};

		if (res.running) {
			dom.content(body, [
				E('div', {}, acquireProgress(steps, kind)),
				E('div', { 'class': 'spinning', 'style': 'margin:1em 0' }, [
					_('The operation is running, it takes a few minutes.'),
					E('br'),
					_('You can close this window — the process continues.')
				]),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			window.setTimeout(function() { pollAcquire(task, body, 0, kind); }, 2000);
			return;
		}

		var ok = last.step === 'done' && last.status === 'ok';
		dom.content(body, [
			E('div', {}, acquireProgress(steps, kind)),
			E('p', { 'class': ok ? '' : 'alert-message warning' },
				kind === 'release' ? (ok ? _('The node has been removed from the system.') : _('The node could not be removed.'))
					: (ok ? _('Finished.') : _('Not finished.'))),
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn cbi-button-positive', 'click': function() { ui.hideModal(); location.reload(); } }, _('Done')))
		]);
	});
}

function renderNodes(state) {
	state = state || {};
	meshViewState = state;

	var deps = state.deps_ready ? '' : E('div', { 'class': 'alert-message warning' }, [
		E('strong', {}, _('Preparing the controller is not finished')),
		E('div', {}, state.deps_state || _('the required packages are not installed yet')),
		E('div', {}, E('small', {}, _('The controller retries by itself every five minutes; make sure it has Internet access.')))
	]);

	var busy = state.acquire && state.acquire.running;

	var addButton = E('button', {
		'class': 'btn cbi-button cbi-button-add',
		'click': discoverDialog,
		'disabled': busy ? 'disabled' : null
	}, _('Add a new node'));

	var kind = busy ? state.acquire.kind : '';
	var kindTitle = kind === 'autoupdate' ? _('Automatic update')
		: kind === 'selfupdate' ? _('Updating the controller')
		: kind === 'update' ? _('Updating the node')
		: kind === 'release' ? _('Remove the node') : _('Capturing the node');
	var kindNote = kind === 'autoupdate' ? _('An automatic update is running now')
		: kind === 'selfupdate' ? _('The controller is being updated now')
		: kind === 'update' ? _('A node is being updated now')
		: kind === 'release' ? _('A node is being removed now') : _('A node is being captured now');

	var running = !busy ? '' : E('div', { 'class': 'alert-message' }, [
		E('strong', {}, kindNote),
		E('div', {}, state.acquire.addr
			? _('Device %s, it takes a few minutes. Do not start another task and do not reset the device.').format(state.acquire.addr)
			: _('It takes a few minutes. Do not start another task and do not reset the device.')),
		E('div', {}, E('button', {
			'class': 'btn cbi-button',
			'click': function() {
				var body = E('div', {}, E('p', { 'class': 'spinning' }, _('Reading the progress…')));

				common.showModal(kindTitle, [ body ]);
				pollAcquire(state.acquire.task_id, body, 0, kind);
			}
		}, _('Show progress')))
	]);

	var members = state.members || [];
	var counts = state.counts || {};
	var pref = '';
	var cards = [ controllerCard(state) ].concat(members.map(function(m) {
		return memberCard(m, state);
	}));

	try {
		pref = uci.get('roamd', 'global', 'prefer_band') || '';
	} catch (e) {}

	var lead = E('p', { 'class': 'roamd-lead', 'style': 'margin:0' }, [
		'%s %s'.format(String(counts.nodes || 0), _('Nodes')),
		' · ',
		E('button', {
			'class': 'roamd-link',
			'click': function(ev) { ev.preventDefault(); openClients(''); }
		}, '%s %s'.format(String(counts.clients || 0), _('Clients'))),
		pref ? ' · ' + preferText(pref) : ''
	]);

	if (nodesView === 'map')
		return renderMeshMap(state, {
			deps: deps,
			running: running,
			lead: lead,
			addButton: addButton
		});

	return E('div', {}, [
		deps, running,
		E('div', { 'class': 'roamd-toolbar' }, [ lead, addButton ]),
		E('div', { 'class': 'roamd-viewbar' }, [
			nodesViewSwitch(),
			mapClientStatus()
		]),
		E('div', { 'class': 'roamd-grid' }, cards)
	]);
}

function mapClientRssi(c) {
	var sample, dbm;

	if (!c || c.wired)
		return null;

	try {
		sample = servingSample(c);
	} catch (e) {
		return null;
	}

	if (!sample || sample.value == null || sample.value === '')
		return null;

	dbm = common.signed(sample.value);
	return dbm ? dbm : null;
}

function mapUplinkRssi(m) {
	var dbm;

	if (!m || m.connection !== 'wifi' || m.uplink_signal == null || m.uplink_signal === '')
		return null;

	dbm = common.signed(m.uplink_signal);
	return dbm ? dbm : null;
}

function mapEdgeMetric(kind, dbm) {
	if (kind === 'wifi' && dbm)
		return '%d %s'.format(dbm, _('dBm'));

	return '';
}

function parentCycle(id, parentId, parentOf) {
	var seen = {};
	var cur = parentId;

	while (cur) {
		if (cur === id || seen[cur])
			return true;

		seen[cur] = true;
		cur = parentOf[cur];
	}

	return false;
}

function meshParentId(m, state) {
	if (!m || !m.via)
		return '';

	if (m.via === 'controller' || bssidOwner(m.via, state.self_aps))
		return 'controller';

	var members = state.members || [];
	var i;

	for (i = 0; i < members.length; i++)
		if (members[i].id !== m.id && bssidOwner(m.via, members[i].aps))
			return members[i].id;

	return '';
}

function meshMapGraph(state) {
	var members = state.members || [];
	var parentOf = {};
	var children = { controller: [] };
	var orphans = [];

	members.forEach(function(m) {
		if (!m || !m.id || m.id === 'controller')
			return;

		children[m.id] = children[m.id] || [];
		parentOf[m.id] = meshParentId(m, state);
	});

	members.forEach(function(m) {
		var p;

		if (!m || !m.id || m.id === 'controller')
			return;

		p = parentOf[m.id];

		if (p && children[p] && !parentCycle(m.id, p, parentOf))
			children[p].push(m.id);
		else
			orphans.push(m.id);
	});

	return { children: children, orphans: orphans, parentOf: parentOf };
}

function mapClientLabel(c, hints, ov) {
	var named = '';

	if (c && c.mac) {
		try {
			named = common.clientLabel(hints || {}, ov || {}, c.mac) || '';
		} catch (e) {}
	}

	if (!named && c && c.host)
		named = c.host;

	return named || (c && c.mac) || '';
}

function mapClientSig(cache) {
	if (!cache)
		return '';

	if (cache.failed)
		return 'failed';

	return (cache.clients || []).map(function(c) {
		return [
			String(c.mac || '').toLowerCase(),
			c.node || '',
			c.state || '',
			c.wired ? '1' : '0',
			c.band || '',
			mapClientRssi(c) == null ? '' : String(mapClientRssi(c)),
			c.rate ? String(c.rate) : '',
			mapClientLabel(c, cache.hints, cache.ov)
		].join('\t');
	}).join('\n');
}

function safeOverrides() {
	try {
		return common.deviceOverrides();
	} catch (e) {
		return {};
	}
}

function mapClientsByNode(state) {
	var cache = mapClientCache;
	var by = {};
	var service;

	if (!cache || cache.failed)
		return by;

	service = serviceMacs(state.members);

	(cache.clients || []).forEach(function(c) {
		var id;

		if (!c || !c.mac || !clientSeen(c) || service[String(c.mac).toLowerCase()])
			return;

		id = c.node || 'controller';
		(by[id] || (by[id] = [])).push(c);
	});

	Object.keys(by).forEach(function(id) {
		by[id].sort(function(a, b) {
			var an = mapClientLabel(a, cache.hints, cache.ov);
			var bn = mapClientLabel(b, cache.hints, cache.ov);
			var am = an === a.mac ? 1 : 0;
			var bm = bn === b.mac ? 1 : 0;

			if (am !== bm)
				return am - bm;

			if (an === bn)
				return 0;

			return an < bn ? -1 : 1;
		});
	});

	return by;
}

function ensureMapClients() {
	var seq;

	if (nodesView !== 'map' || !mapShowClients)
		return;

	seq = ++mapClientSeq;

	return Promise.all([
		callMeshClients().catch(function() { return null; }),
		common.hostHints().catch(function() { return {}; }),
		uci.load('roamd').catch(function() { return null; })
	]).then(function(res) {
		var next, list, trafficChanged, mapChanged;

		if (seq !== mapClientSeq)
			return;

		if (!res[0]) {
			next = { clients: [], hints: {}, ov: {}, failed: true };
		} else {
			list = (res[0] && res[0].clients) || res[0] || [];

			if (!Array.isArray(list))
				list = [];

			next = {
				clients: list,
				hints: res[1] || {},
				ov: safeOverrides(),
				failed: false
			};
		}

		trafficChanged = noteClientTraffic(next);
		mapChanged = !mapClientCache || mapClientSig(next) !== mapClientSig(mapClientCache);
		mapClientCache = next;

		if ((trafficChanged || mapChanged) && nodesView === 'map' && mapShowClients)
			replaceNodes(meshViewState);
	}, function() {
		if (seq !== mapClientSeq)
			return;

		if (mapClientCache && mapClientCache.failed)
			return;

		mapClientCache = { clients: [], hints: {}, ov: {}, failed: true };
		noteClientTraffic(mapClientCache);

		if (nodesView === 'map' && mapShowClients)
			replaceNodes(meshViewState);
	});
}

function nodesViewSwitch() {
	function option(id, label) {
		return E('label', { 'class': 'roamd-switch-opt' }, [
			E('input', {
				'type': 'radio',
				'name': 'roamd-nodes-view',
				'value': id,
				'checked': nodesView === id ? 'checked' : null,
				'change': function() {
					if (nodesView === id)
						return;

					nodesView = id;
					replaceNodes(meshViewState);
					ensureMapClients();
				}
			}),
			E('span', {}, label)
		]);
	}

	return E('div', {
		'class': 'roamd-switch',
		'role': 'radiogroup',
		'aria-label': _('View')
	}, [
		option('cards', _('Dashboard')),
		option('map', _('Map'))
	]);
}

function mapClientSwitch() {
	return E('label', { 'class': 'roamd-switch-check' }, [
		E('input', {
			'type': 'checkbox',
			'checked': mapShowClients ? 'checked' : null,
			'change': function(ev) {
				mapShowClients = !!ev.target.checked;
				replaceNodes(meshViewState);
				ensureMapClients();
			}
		}),
		E('span', { 'class': 'roamd-switch-ui', 'aria-hidden': 'true' }),
		E('span', {}, _('Show clients'))
	]);
}

function mapClientStatus() {
	if (nodesView !== 'map' || !mapShowClients)
		return '';

	if (!mapClientCache)
		return E('span', { 'class': 'roamd-muted' }, _('Loading clients…'));

	if (mapClientCache.failed)
		return E('span', { 'class': 'roamd-muted' }, _('Clients could not be loaded'));

	return '';
}

/* mapgeom-start */
var MAP_THEME = {
	bg: 'var(--roamd-map-bg, #16181d)',
	grid: 'var(--roamd-map-grid, #353c47)',
	star: 'var(--roamd-map-star, #e04e5d)',
	starStroke: 'var(--roamd-map-starstroke, #4a1820)',
	node: 'var(--roamd-map-node, #4ea3e0)',
	nodeStroke: 'var(--roamd-map-nodestroke, #143044)',
	client: 'var(--roamd-map-client, #97b552)',
	clientStroke: 'var(--roamd-map-clientstroke, #243012)',
	unknown: 'var(--roamd-map-unknown, #e0a15a)',
	off: 'var(--roamd-map-off, #8a93a0)',
	cable: 'var(--roamd-map-cable, #9aa7b8)',
	radio: 'var(--roamd-map-radio, #e0a15a)',
	label: 'var(--roamd-map-label, #f4f6f8)',
	mac: 'var(--roamd-map-mac, #b7bdc7)',
	metric: 'var(--roamd-map-metric, #c5cad3)',
	metricRadio: 'var(--roamd-map-metricradio, #f0c48a)',
	speed: 'var(--roamd-map-speed, #d7e4f5)',
	legend: 'var(--roamd-map-legend, #d5d8de)',
	dot: 'var(--roamd-map-dot, #f7f4ea)',
	haloC: 'var(--roamd-map-haloc, rgba(224,78,93,0.30))',
	haloN: 'var(--roamd-map-halon, rgba(78,163,224,0.24))',
	haloK: 'var(--roamd-map-halok, rgba(151,181,82,0.22))'
};

function mapGeomHypot(x, y) {
	return Math.sqrt(x * x + y * y);
}

function mapGeomRadius(kind) {
	if (kind === 'controller')
		return 16;

	if (kind === 'client')
		return 7;

	return 12;
}

function mapGeomTextWidth(text, size) {
	var s = String(text || '');
	var w = 0;
	var i, c;

	for (i = 0; i < s.length; i++) {
		c = s.charCodeAt(i);
		if (c === 32)
			w += size * 0.34;
		else if (c === 58)
			w += size * 0.36;
		else if (c < 128)
			w += size * 0.60;
		else
			w += size * 0.64;
	}

	return w;
}

function mapGeomSplitName(text) {
	var parts, best, score, i, left, right, diff;

	text = String(text || '');

	if (text.length <= 16)
		return [ text ];

	parts = text.split(/\s+/);

	if (parts.length < 2)
		return [ text ];

	best = 1;
	score = 1e9;

	for (i = 1; i < parts.length; i++) {
		left = parts.slice(0, i).join(' ');
		right = parts.slice(i).join(' ');
		diff = Math.abs(left.length - right.length);

		if (diff < score) {
			score = diff;
			best = i;
		}
	}

	return [ parts.slice(0, best).join(' '), parts.slice(best).join(' ') ];
}

function mapGeomLines(name, mac) {
	var lines = [];
	var showName = !!(name && (!mac || String(name).toLowerCase() !== String(mac).toLowerCase()));

	if (showName) {
		mapGeomSplitName(name).forEach(function(part) {
			if (!part)
				return;

			lines.push({ text: part, size: 15, fill: MAP_THEME.label, weight: 600 });
		});
	}

	if (mac)
		lines.push({
			text: String(mac),
			size: showName ? 11 : 15,
			secondary: showName,
			fill: showName ? MAP_THEME.mac : MAP_THEME.label,
			weight: showName ? 400 : 600
		});

	if (!lines.length)
		lines.push({ text: name || mac || '', size: 15, fill: MAP_THEME.label, weight: 600 });

	return lines;
}

function mapGeomMeasure(lines) {
	var w = 0;
	var h = 0;

	(lines || []).forEach(function(ln, i) {
		w = Math.max(w, mapGeomTextWidth(ln.text, ln.size));
		h += ln.size + (i ? 3 : 0);
	});

	return { w: w, h: Math.max(h, 12) };
}

function mapGeomLabelSpan(lines) {
	return mapGeomMeasure(lines).w + 22;
}

function mapGeomBox(x, y, anchor, lines) {
	var m = mapGeomMeasure(lines);
	var x0 = x - m.w / 2;

	if (anchor === 'start')
		x0 = x;
	else if (anchor === 'end')
		x0 = x - m.w;

	return {
		x: x,
		y: y,
		anchor: anchor,
		lines: lines,
		x0: x0,
		y0: y - (lines[0] ? lines[0].size : 12),
		x1: x0 + m.w,
		y1: y - (lines[0] ? lines[0].size : 12) + m.h
	};
}

function mapGeomStar(cx, cy, outer, inner, n) {
	var pts = [];
	var i, a, r;

	for (i = 0; i < n * 2; i++) {
		a = -Math.PI / 2 + i * Math.PI / n;
		r = (i % 2) ? inner : outer;
		pts.push((Math.round(cx + Math.cos(a) * r * 10) / 10) + ',' +
			(Math.round(cy + Math.sin(a) * r * 10) / 10));
	}

	return pts.join(' ');
}

function mapGeomAngForward(from, to) {
	var d = to - from;

	while (d <= 0)
		d += Math.PI * 2;

	while (d > Math.PI * 2)
		d -= Math.PI * 2;

	return d;
}

function mapGeomRingCap(r, sector, span) {
	var arc = Math.max(0.35, sector) * 0.9;
	var half = span / 2;

	if (!(r > half + 4))
		return 1;

	var step = 2 * Math.asin(Math.min(0.96, half / r));

	if (!(step > 0))
		return 1;

	return Math.max(1, Math.floor(arc / step) + 1);
}

function mapGeomLayout(items) {
	var byId = {};
	var list = [];
	var structKids = {};
	var clientKids = {};
	var pos = {};
	var seen = {};
	var rootKids, nRoot, ring, start, i, id;

	(items || []).forEach(function(item) {
		var copy, parent;

		if (!item || !item.id || byId[item.id])
			return;

		copy = {
			id: item.id,
			kind: item.kind || 'node',
			parent: item.parent || '',
			name: item.name || '',
			mac: item.mac || '',
			online: item.online !== false,
			unknown: !!item.unknown,
			link: item.link || '',
			metric: item.metric || '',
			metricKind: item.metricKind || '',
			active: !!item.active
		};
		copy.lines = mapGeomLines(copy.name, copy.mac);
		parent = copy.parent;

		if (copy.kind === 'controller')
			parent = '';
		else if (parent && parent !== 'controller') {
			/* parent may not be copied yet; resolved after the scan */
		}

		copy.parent = parent;
		byId[copy.id] = copy;
		list.push(copy);
	});

	if (!byId.controller) {
		byId.controller = {
			id: 'controller',
			kind: 'controller',
			parent: '',
			name: '',
			mac: '',
			online: true,
			unknown: false,
			link: '',
			metric: '',
			metricKind: '',
			lines: mapGeomLines('', '')
		};
		list.unshift(byId.controller);
	}

	list.forEach(function(item) {
		if (item.kind === 'controller') {
			item.parent = '';
			return;
		}

		if (item.parent && !byId[item.parent])
			item.parent = item.kind === 'client' ? 'controller' : '';
	});

	function addChild(bucket, pid, cid) {
		if (!bucket[pid])
			bucket[pid] = [];

		bucket[pid].push(cid);
	}

	list.forEach(function(item) {
		if (item.kind === 'controller')
			return;

		if (item.kind === 'client')
			addChild(clientKids, item.parent || 'controller', item.id);
		else
			addChild(structKids, item.parent || '', item.id);
	});

	function byLabel(a, b) {
		var an = byId[a];
		var bn = byId[b];
		var as = ((an.name || an.mac || an.id) + '').toLowerCase();
		var bs = ((bn.name || bn.mac || bn.id) + '').toLowerCase();

		if (as < bs)
			return -1;

		if (as > bs)
			return 1;

		return an.id < bn.id ? -1 : (an.id > bn.id ? 1 : 0);
	}

	Object.keys(structKids).forEach(function(pid) {
		structKids[pid].sort(byLabel);
	});
	Object.keys(clientKids).forEach(function(pid) {
		clientKids[pid].sort(byLabel);
	});

	pos.controller = { x: 0, y: 0, angle: -Math.PI / 2, depth: 0 };
	rootKids = (structKids.controller || []).concat(structKids[''] || []);
	nRoot = rootKids.length;
	ring = 228;

	if (nRoot > 1) {
		var widest = 120;

		rootKids.forEach(function(cid) {
			widest = Math.max(widest, mapGeomLabelSpan(byId[cid].lines));
		});
		ring = Math.max(228, (widest + 56) / (2 * Math.sin(Math.PI / nRoot)));
	}

	start = -0.62;

	rootKids.forEach(function(cid, idx) {
		var a = nRoot ? start + idx * (Math.PI * 2 / nRoot) : start;

		pos[cid] = {
			x: Math.cos(a) * ring,
			y: Math.sin(a) * ring,
			angle: a,
			depth: 1
		};
	});

	function placeSubtree(pid, depth) {
		var kids = structKids[pid] || [];
		var p = pos[pid];
		var spread, baseR, step, a0;

		if (!p || !kids.length || seen[pid])
			return;

		seen[pid] = true;
		spread = Math.min(Math.PI * 0.85, Math.max(0.7, 0.42 * kids.length));
		baseR = mapGeomHypot(p.x, p.y) + 210;
		step = kids.length > 1 ? spread / (kids.length - 1) : 0;
		a0 = p.angle - spread / 2;

		kids.forEach(function(cid, idx) {
			var a;

			if (pos[cid])
				return;

			a = kids.length === 1 ? p.angle : a0 + step * idx;
			pos[cid] = {
				x: Math.cos(a) * baseR,
				y: Math.sin(a) * baseR,
				angle: a,
				depth: depth + 1
			};
			placeSubtree(cid, depth + 1);
		});
	}

	rootKids.forEach(function(cid) {
		placeSubtree(cid, 1);
	});
	seen.controller = true;

	function placeClients(pid, ids, sector, center, baseR) {
		var left = (ids || []).slice();
		var r = Math.max(baseR, 200);
		var guard = 0;

		while (left.length && guard < 10) {
			var widest = 100;
			var goal, cap, take, m, arc, step, minStep, t, a, cid;

			guard++;
			left.forEach(function(cid) {
				widest = Math.max(widest, mapGeomLabelSpan(byId[cid].lines));
			});
			goal = Math.min(left.length, sector > 2.2 ? 8 : 6);

			while (r < baseR + 900 && mapGeomRingCap(r, sector, widest) < goal)
				r += 42;

			cap = Math.max(1, mapGeomRingCap(r, sector, widest));
			take = left.splice(0, cap);
			m = take.length;
			arc = Math.max(0.2, sector) * 0.88;
			step = m > 1 ? arc / (m - 1) : 0;
			minStep = widest >= r * 1.9 ? step : 2 * Math.asin(Math.min(0.96, (widest / 2) / r));

			if (m > 1 && step < minStep) {
				step = minStep;
				arc = step * (m - 1);
			}

			for (t = 0; t < m; t++) {
				cid = take[t];
				a = m === 1 ? center : (center - arc / 2 + arc * (t / (m - 1)));
				pos[cid] = {
					x: Math.cos(a) * r,
					y: Math.sin(a) * r,
					angle: a,
					depth: (pos[pid] ? pos[pid].depth + 1 : 1)
				};
			}

			r += Math.max(112, Math.round(widest * 0.42));
		}
	}

	var ordered = rootKids.slice().sort(function(a, b) {
		return pos[a].angle - pos[b].angle;
	});

	ordered.forEach(function(cid, idx) {
		var clients = clientKids[cid] || [];
		var a, prev, next, gapPrev, gapNext, sector, parentR;

		if (!clients.length)
			return;

		a = pos[cid].angle;

		if (ordered.length < 2) {
			sector = Math.PI * 1.35;
		} else {
			prev = pos[ordered[(idx - 1 + ordered.length) % ordered.length]].angle;
			next = pos[ordered[(idx + 1) % ordered.length]].angle;
			gapPrev = mapGeomAngForward(prev, a);
			gapNext = mapGeomAngForward(a, next);
			sector = Math.min(Math.PI * 1.05, (gapPrev / 2 + gapNext / 2) * 0.82);
		}

		parentR = mapGeomHypot(pos[cid].x, pos[cid].y);
		placeClients(cid, clients, Math.max(0.7, sector), a, parentR + 176);
	});

	Object.keys(clientKids).forEach(function(pid) {
		var p, clients;

		if (pid === 'controller' || !pid)
			return;

		if (ordered.indexOf(pid) >= 0 || !pos[pid])
			return;

		clients = clientKids[pid] || [];
		p = pos[pid];
		placeClients(pid, clients, Math.PI * 0.9, p.angle, mapGeomHypot(p.x, p.y) + 176);
	});

	(function placeControllerClients() {
		var clients = (clientKids.controller || []).concat(clientKids[''] || []);
		var gaps, buckets, g;

		if (!clients.length)
			return;

		if (!ordered.length) {
			placeClients('controller', clients, Math.PI * 2, -Math.PI / 2, ring + 40);
			return;
		}

		gaps = [];

		for (g = 0; g < ordered.length; g++) {
			var a0 = pos[ordered[g]].angle;
			var a1 = pos[ordered[(g + 1) % ordered.length]].angle;
			var span = mapGeomAngForward(a0, a1);

			gaps.push({ mid: a0 + span / 2, span: span });
		}

		buckets = gaps.map(function() { return []; });
		clients.forEach(function(cid) {
			var best = 0;
			var gi;

			for (gi = 1; gi < gaps.length; gi++) {
				if (buckets[gi].length / gaps[gi].span < buckets[best].length / gaps[best].span)
					best = gi;
			}

			buckets[best].push(cid);
		});

		buckets.forEach(function(bucket, gi) {
			var span = gaps[gi].span;
			var s, r;

			if (!bucket.length)
				return;

			s = Math.sin(Math.min(span / 4, 1.15));
			r = ring + 36;

			if (s > 0.08)
				r = Math.max(r, 150 / (2 * s));

			placeClients('controller', bucket, Math.max(0.55, span * 0.52), gaps[gi].mid, r);
		});
	})();

	function separate() {
		var ids = Object.keys(pos);
		var k, i, j, a, b, na, nb, dx, dy, d, minD, push, parent, minOut;

		for (k = 0; k < 48; k++) {
			var moved = false;

			for (i = 0; i < ids.length; i++) {
				na = byId[ids[i]];

				if (!na || na.kind !== 'client' || !pos[na.parent])
					continue;

				a = pos[ids[i]];
				parent = pos[na.parent];
				dx = a.x - parent.x;
				dy = a.y - parent.y;
				d = mapGeomHypot(dx, dy) || 1;
				minOut = mapGeomRadius(byId[na.parent].kind) + mapGeomRadius('client') + 132;

				if (d < minOut) {
					a.x = parent.x + dx / d * minOut;
					a.y = parent.y + dy / d * minOut;
					moved = true;
				}
			}

			for (i = 0; i < ids.length; i++) {
				for (j = i + 1; j < ids.length; j++) {
					a = pos[ids[i]];
					b = pos[ids[j]];
					na = byId[ids[i]];
					nb = byId[ids[j]];
					dx = b.x - a.x;
					dy = b.y - a.y;
					d = mapGeomHypot(dx, dy) || 0.01;
					minD = mapGeomRadius(na.kind) + mapGeomRadius(nb.kind) + 30;

					if (d >= minD)
						continue;

					push = (minD - d);

					if (na.kind === 'controller' && nb.kind === 'controller')
						continue;

					if (na.kind === 'controller') {
						b.x += dx / d * push;
						b.y += dy / d * push;
					} else if (nb.kind === 'controller') {
						a.x -= dx / d * push;
						a.y -= dy / d * push;
					} else {
						a.x -= dx / d * push / 2;
						a.y -= dy / d * push / 2;
						b.x += dx / d * push / 2;
						b.y += dy / d * push / 2;
					}

					moved = true;
				}
			}

			if (!moved)
				break;
		}

		Object.keys(pos).forEach(function(cid) {
			if (byId[cid] && byId[cid].kind === 'controller')
				return;

			pos[cid].angle = Math.atan2(pos[cid].y, pos[cid].x);
		});
	}

	separate();

	function placeLabel(item) {
		var p = pos[item.id];
		var lines = item.lines;
		var measured = mapGeomMeasure(lines);
		var anchor, x, y, a, c, s;

		if (item.kind === 'controller') {
			anchor = 'middle';
			x = p.x;
			y = p.y + mapGeomRadius(item.kind) + 18;
		} else if (item.kind === 'node') {
			anchor = 'middle';
			x = p.x;
			y = p.y - mapGeomRadius(item.kind) - 18 - measured.h + lines[0].size;
		} else {
			a = Math.atan2(p.y, p.x);
			c = Math.cos(a);
			s = Math.sin(a);

			if (Math.abs(c) >= 0.42) {
				anchor = c > 0 ? 'start' : 'end';
				x = p.x + c * (mapGeomRadius(item.kind) + 9);
				y = p.y + s * 8 + lines[0].size * 0.35;
			} else if (s >= 0) {
				anchor = 'middle';
				x = p.x;
				y = p.y + mapGeomRadius(item.kind) + 16;
			} else {
				anchor = 'middle';
				x = p.x;
				y = p.y - mapGeomRadius(item.kind) - 8 - measured.h + lines[0].size;
			}
		}

		item.label = mapGeomBox(x, y, anchor, lines);
		item.x = p.x;
		item.y = p.y;
		item.r = mapGeomRadius(item.kind);
		item.angle = p.angle;
	}

	list.forEach(function(item) {
		if (pos[item.id])
			placeLabel(item);
	});

	function pushLabel(item, dx, dy) {
		var box = item.label;

		box.x += dx;
		box.y += dy;
		box.x0 += dx;
		box.y0 += dy;
		box.x1 += dx;
		box.y1 += dy;
	}

	function overlap(a, b, pad) {
		return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;
	}

	function hitsCircle(box, x, y, r) {
		var cx = Math.max(box.x0, Math.min(x, box.x1));
		var cy = Math.max(box.y0, Math.min(y, box.y1));
		var dx = cx - x;
		var dy = cy - y;

		return dx * dx + dy * dy < r * r;
	}

	(function separateLabels() {
		var labeled = list.filter(function(item) { return item.label; });
		var k, i, j, a, b, dx, dy, ox, oy, sx, sy, push;

		for (k = 0; k < 56; k++) {
			var moved = false;

			for (i = 0; i < labeled.length; i++) {
				for (j = i + 1; j < labeled.length; j++) {
					a = labeled[i].label;
					b = labeled[j].label;

					if (!overlap(a, b, 5))
						continue;

					dx = ((b.x0 + b.x1) - (a.x0 + a.x1)) || 1;
					dy = ((b.y0 + b.y1) - (a.y0 + a.y1)) || 0.2;
					ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
					oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);

					if (ox < oy) {
						sx = dx >= 0 ? 1 : -1;
						push = ox / 2 + 4;
						pushLabel(labeled[i], -sx * push, 0);
						pushLabel(labeled[j], sx * push, 0);
					} else {
						sy = dy >= 0 ? 1 : -1;
						push = oy / 2 + 4;
						pushLabel(labeled[i], 0, -sy * push);
						pushLabel(labeled[j], 0, sy * push);
					}

					moved = true;
				}
			}

			for (i = 0; i < labeled.length; i++) {
				for (j = 0; j < labeled.length; j++) {
					if (!hitsCircle(labeled[i].label, labeled[j].x, labeled[j].y, labeled[j].r + 12))
						continue;

					dx = (labeled[i].label.x0 + labeled[i].label.x1) / 2 - labeled[j].x;
					dy = (labeled[i].label.y0 + labeled[i].label.y1) / 2 - labeled[j].y;

					if (mapGeomHypot(dx, dy) < 1) {
						dx = 0;
						dy = labeled[i].kind === 'controller' ? 1 : -1;
					}

					var len = mapGeomHypot(dx, dy) || 1;

					pushLabel(labeled[i], dx / len * 7, dy / len * 7);
					moved = true;
				}
			}

			if (!moved)
				break;
		}
	})();

	var nodes = list.filter(function(item) { return !!pos[item.id]; });
	var edges = [];

	nodes.forEach(function(item) {
		var parent, a, b, dx, dy, len, px, py, mx, my, tries, show, box, t, lx, ly;

		if (!item.parent || !pos[item.parent] || !pos[item.id])
			return;

		if (item.kind !== 'client' && !item.link)
			return;

		parent = byId[item.parent];
		a = {
			x: pos[item.parent].x,
			y: pos[item.parent].y
		};
		b = { x: pos[item.id].x, y: pos[item.id].y };
		dx = b.x - a.x;
		dy = b.y - a.y;
		len = mapGeomHypot(dx, dy) || 1;
		a = {
			x: a.x + dx / len * (mapGeomRadius(parent.kind) + 11),
			y: a.y + dy / len * (mapGeomRadius(parent.kind) + 11)
		};
		b = {
			x: b.x - dx / len * (mapGeomRadius(item.kind) + 11),
			y: b.y - dy / len * (mapGeomRadius(item.kind) + 11)
		};
		dx = b.x - a.x;
		dy = b.y - a.y;
		len = mapGeomHypot(dx, dy) || 1;
		px = -dy / len;
		py = dx / len;

		if (py > 0) {
			px = -px;
			py = -py;
		}

		show = false;
		lx = (a.x + b.x) / 2;
		ly = (a.y + b.y) / 2;

		if (item.metric) {
			var mw = mapGeomTextWidth(item.metric, 11) + 8;
			var mh = 14;

			for (t = 0; t < 5; t++) {
				var dist = 12 + t * 7;
				var flip = t % 2 ? -1 : 1;

				mx = (a.x + b.x) / 2 + px * dist * flip;
				my = (a.y + b.y) / 2 + py * dist * flip;
				box = {
					x0: mx - mw / 2,
					y0: my - 11,
					x1: mx + mw / 2,
					y1: my + 3
				};

				var blocked = false;
				var n;

				for (n = 0; n < nodes.length; n++) {
					if (hitsCircle(box, nodes[n].x, nodes[n].y, nodes[n].r + 4) ||
						(nodes[n].label && overlap(box, nodes[n].label, 2))) {
						blocked = true;
						break;
					}
				}

				if (!blocked) {
					show = true;
					lx = mx;
					ly = my;
					break;
				}
			}
		}

		edges.push({
			from: item.parent,
			to: item.id,
			kind: item.link || (item.kind === 'client' ? 'wifi' : ''),
			metric: show ? item.metric : '',
			metricKind: show ? item.metricKind : '',
			x1: a.x,
			y1: a.y,
			x2: b.x,
			y2: b.y,
			lx: lx,
			ly: ly,
			active: !!item.active
		});
	});

	var bounds = null;

	function grow(x, y) {
		if (!bounds) {
			bounds = { x0: x, y0: y, x1: x, y1: y };
			return;
		}

		bounds.x0 = Math.min(bounds.x0, x);
		bounds.y0 = Math.min(bounds.y0, y);
		bounds.x1 = Math.max(bounds.x1, x);
		bounds.y1 = Math.max(bounds.y1, y);
	}

	nodes.forEach(function(item) {
		grow(item.x - item.r, item.y - item.r);
		grow(item.x + item.r, item.y + item.r);

		if (item.label) {
			grow(item.label.x0, item.label.y0);
			grow(item.label.x1, item.label.y1);
		}
	});
	edges.forEach(function(edge) {
		grow(edge.x1, edge.y1);
		grow(edge.x2, edge.y2);

		if (edge.metric)
			grow(edge.lx, edge.ly);
	});

	if (!bounds)
		bounds = { x0: -80, y0: -80, x1: 80, y1: 80 };

	return {
		nodes: nodes,
		edges: edges,
		bounds: bounds
	};
}

function mapGeomFit(w, h, bounds) {
	var pad = 32;
	var bw = Math.max(40, bounds.x1 - bounds.x0);
	var bh = Math.max(40, bounds.y1 - bounds.y0);
	var k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);

	if (!isFinite(k) || k <= 0)
		k = 1;

	k = Math.max(0.12, Math.min(k, 2.5));

	return {
		k: k,
		x: (w - bw * k) / 2 - bounds.x0 * k,
		y: (h - bh * k) / 2 - bounds.y0 * k
	};
}
/* mapgeom-end */

function svgEl(tag, attrs, children) {
	var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	var key;

	attrs = attrs || {};

	for (key in attrs)
		if (attrs[key] != null && attrs[key] !== '')
			el.setAttribute(key, String(attrs[key]));

	(children || []).forEach(function(child) {
		if (child == null || child === '')
			return;

		el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	});

	return el;
}

function mapReduceMotion() {
	try {
		return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch (e) {
		return false;
	}
}

/* Bridge throughput is kbit/s from the daemon. Both fields are absent until two samples exist. */
function mapBridgeSpeed(src) {
	var rx, tx, parts;

	if (!src || src.rx_kbps == null || src.tx_kbps == null)
		return '';

	rx = Number(src.rx_kbps);
	tx = Number(src.tx_kbps);
	parts = [];

	if (isFinite(rx) && rx > 0)
		parts.push('↓' + formatMbps(rx));

	if (isFinite(tx) && tx > 0)
		parts.push('↑' + formatMbps(tx));

	if (!parts.length)
		return '';

	return parts.join(' ') + ' ' + _('Mbit/s');
}

/* iwinfo PHY rate, kbit/s. Idle clients still report it; it is not a traffic counter. */
function mapPhySpeed(rate) {
	var n = Number(rate);

	if (!isFinite(n) || n <= 0)
		return '';

	return '%d %s'.format(Math.round(n / 1000), _('Mbit/s'));
}

function mapBridgeActive(src) {
	if (!src || src.rx_kbps == null || src.tx_kbps == null)
		return false;

	return Number(src.rx_kbps) > 0 || Number(src.tx_kbps) > 0;
}

function noteClientTraffic(cache) {
	var bytes = {};
	var macs = {};
	var previousMacs = mapLive.macs;

	cache.clients.forEach(function(c) {
		var key, rx, tx, prev;

		if (!c || !c.mac)
			return;

		key = String(c.mac).toLowerCase();
		rx = Number(c.rx_bytes);
		tx = Number(c.tx_bytes);

		if (!isFinite(rx))
			rx = 0;

		if (!isFinite(tx))
			tx = 0;

		prev = mapLive.bytes[key];

		if (prev && (rx > prev.rx || tx > prev.tx))
			macs[key] = true;

		bytes[key] = { rx: rx, tx: tx };
	});

	mapLive.bytes = bytes;
	mapLive.macs = macs;

	return Object.keys(previousMacs).length !== Object.keys(macs).length ||
		Object.keys(macs).some(function(mac) { return !previousMacs[mac]; });
}

function mapRecentMotion(state) {
	var now = Date.now() / 1000;
	var nodes = {};
	var macs = {};

	(state.members || []).forEach(function(m) {
		(m.events || []).forEach(function(ev) {
			var age;

			if (!ev || ev.ts == null)
				return;

			if (ev.type !== 'roam' && ev.type !== 'steer')
				return;

			age = now - Number(ev.ts);

			if (!isFinite(age) || age < 0 || age > 20)
				return;

			if (m && m.id)
				nodes[m.id] = true;

			if (ev.to_node)
				nodes[ev.to_node] = true;

			if (ev.from_node)
				nodes[ev.from_node] = true;

			if (ev.mac)
				macs[String(ev.mac).toLowerCase()] = true;
		});
	});

	return { nodes: nodes, macs: macs };
}

function mapLegend() {
	function sample(dashed, label) {
		var line = {
			x1: 0, y1: 6, x2: 34, y2: 6,
			stroke: dashed ? MAP_THEME.radio : MAP_THEME.cable,
			'stroke-width': 2,
			fill: 'none'
		};
		var svg = svgEl('svg', {
			'width': 36,
			'height': 12,
			'viewBox': '0 0 36 12',
			'aria-hidden': 'true'
		});
		var span;

		if (dashed)
			line['stroke-dasharray'] = '5 4';

		svg.appendChild(svgEl('line', line));
		svg.style.display = 'block';
		svg.style.flex = '0 0 auto';
		span = E('span', {
			'style': 'display:inline-flex;align-items:center;gap:8px'
		}, [ label ]);
		span.insertBefore(svg, span.firstChild);
		return span;
	}

	return E('div', {
		'style': 'position:absolute;top:10px;left:14px;z-index:2;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;color:' + MAP_THEME.legend + ';font-size:13px;pointer-events:none'
	}, [
		sample(false, _('Cable')),
		sample(true, _('Radio'))
	]);
}

function mapZoomButton(label, title, fn) {
	return E('button', {
		'type': 'button',
		'class': 'btn cbi-button',
		'title': title,
		'aria-label': title,
		'style': 'min-width:2.4rem;padding:0 .55rem',
		'click': function(ev) {
			ev.preventDefault();
			fn();
		}
	}, label);
}

function mapApplyCam(world) {
	if (!world)
		return;

	world.classList.toggle('roamd-map-detail', mapCam.k >= 1);
	world.setAttribute('transform',
		'translate(' + mapCam.x + ' ' + mapCam.y + ') scale(' + mapCam.k + ')');
}

function mapFitCam(w, h, bounds) {
	var fit = mapGeomFit(w, h, bounds || { x0: -80, y0: -80, x1: 80, y1: 80 });

	mapCam.k = fit.k;
	mapCam.x = fit.x;
	mapCam.y = fit.y;
	mapCam.w = w;
	mapCam.h = h;
}

function bindMapStage(overlay) {
	var stage = overlay.querySelector('.roamd-map-stage');
	var svg = overlay.querySelector('.roamd-map-svg');
	var world = overlay.querySelector('.roamd-map-world');
	var bounds = overlay._bounds;
	var ptr = null;

	if (!stage || !svg || !world)
		return;

	if (mapObserver) {
		mapObserver.disconnect();
		mapObserver = null;
	}

	function size() {
		var w = stage.clientWidth;
		var h = stage.clientHeight;

		if (w < 40 || h < 40)
			return false;

		svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
		mapCam.w = w;
		mapCam.h = h;
		return true;
	}

	function fit() {
		if (!size())
			return;

		mapFitCam(mapCam.w, mapCam.h, bounds);
		mapApplyCam(world);
	}

	function zoomAt(factor, cx, cy) {
		var wx, wy, nk;

		if (!size())
			return;

		nk = Math.max(0.15, Math.min(4, mapCam.k * factor));
		wx = (cx - mapCam.x) / mapCam.k;
		wy = (cy - mapCam.y) / mapCam.k;
		mapCam.k = nk;
		mapCam.x = cx - wx * nk;
		mapCam.y = cy - wy * nk;
		mapCam.user = true;
		mapApplyCam(world);
	}

	overlay._zoom = function(factor) {
		zoomAt(factor, (stage.clientWidth || 0) / 2, (stage.clientHeight || 0) / 2);
	};
	overlay._fit = function() {
		mapCam.user = false;
		fit();
	};

	function nodeKey(target) {
		var el = target;

		while (el && el !== stage) {
			if (el.getAttribute && el.getAttribute('data-key'))
				return el.getAttribute('data-key');

			el = el.parentNode;
		}

		return '';
	}

	function onWheel(ev) {
		ev.preventDefault();
		zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12,
			ev.clientX - stage.getBoundingClientRect().left,
			ev.clientY - stage.getBoundingClientRect().top);
	}

	try {
		stage.addEventListener('wheel', onWheel, { passive: false });
	} catch (e) {
		stage.addEventListener('wheel', onWheel);
	}

	stage.addEventListener('pointerdown', function(ev) {
		if (ev.button != null && ev.button !== 0)
			return;

		ptr = {
			id: ev.pointerId,
			x: ev.clientX,
			y: ev.clientY,
			ox: mapCam.x,
			oy: mapCam.y,
			moved: false,
			key: nodeKey(ev.target)
		};
		stage.style.cursor = 'grabbing';

		try {
			stage.setPointerCapture(ev.pointerId);
		} catch (e) {}
	});

	stage.addEventListener('pointermove', function(ev) {
		var dx, dy;

		if (!ptr || ev.pointerId !== ptr.id)
			return;

		dx = ev.clientX - ptr.x;
		dy = ev.clientY - ptr.y;

		if (!ptr.moved && dx * dx + dy * dy < 36)
			return;

		ptr.moved = true;
		mapCam.user = true;
		mapCam.x = ptr.ox + dx;
		mapCam.y = ptr.oy + dy;
		mapApplyCam(world);
	});

	function endPtr(ev) {
		var key, moved;

		if (!ptr || (ev && ev.pointerId !== ptr.id))
			return;

		key = ptr.key;
		moved = ptr.moved;
		ptr = null;
		stage.style.cursor = 'grab';

		if (!moved && key && ev.type === 'pointerup')
			activateNode(key);
	}

	function activateNode(key) {
		var extra = overlay._extras[key];

		if (!extra)
			return;

		if (extra.kind === 'controller')
			controllerDialog(overlay._state);
		else if (extra.member)
			nodeDialog(extra.member, overlay._state, refreshNodes);
		else if (extra.kind === 'client' && mapClientCache) {
			var cache = mapClientCache;
			var client = cache.clients.find(function(c) {
				return c && c.mac && 'c:' + c.mac.toLowerCase() === key;
			});

			if (client)
				clientDialog(client, cache.hints, cache.ov, clientNodeChoices(overlay._state), function() {
					return Promise.resolve(refreshClients()).then(ensureMapClients);
				});
		}
	}

	stage.addEventListener('pointerup', endPtr);
	stage.addEventListener('pointercancel', endPtr);
	stage.addEventListener('keydown', function(ev) {
		var key = nodeKey(ev.target);

		if (key && (ev.key === 'Enter' || ev.key === ' ')) {
			ev.preventDefault();
			activateNode(key);
		}
	});

	if (typeof ResizeObserver !== 'undefined') {
		mapObserver = new ResizeObserver(function() {
			if (!size())
				return;

			if (!mapCam.user)
				fit();
			else
				mapApplyCam(world);
		});
		mapObserver.observe(stage);
	}

	if (size()) {
		if (!mapCam.user)
			fit();
		else
			mapApplyCam(world);
	}
}

function scheduleMapBind(overlay) {
	var seq = ++mapBindSeq;

	setTimeout(function() {
		var live;

		if (seq !== mapBindSeq)
			return;

		live = document.getElementById('roamd-map-overlay');

		if (live)
			bindMapStage(live);
	}, 0);
}

function mapPaint(scene, extras) {
	var bounds = scene.bounds;
	var width = mapCam.w || 800;
	var height = mapCam.h || 600;
	var svg, defs, world, motion;
	var nodeGroups = [];
	var edgeGroups = [];
	var hovered = '', focused = '';

	function highlightBranch() {
		var key = hovered || focused;
		var related = new Set([key]);

		edgeGroups.forEach(function(group) {
			var edge = group.edge;
			var active = edge.from === key || edge.to === key;

			if (active) {
				related.add(edge.from);
				related.add(edge.to);
			}

			group.el.classList.toggle('roamd-map-muted', !!key && !active);
			group.el.classList.toggle('roamd-map-highlight', active);
		});

		nodeGroups.forEach(function(group) {
			group.el.classList.toggle('roamd-map-muted', !!key && !related.has(group.id));
		});
	}

	if (!mapCam.user && mapCam.w && mapCam.h)
		mapFitCam(width, height, bounds);

	motion = !mapReduceMotion();
	svg = svgEl('svg', {
		'class': 'roamd-map-svg',
		'width': '100%',
		'height': '100%',
		'viewBox': '0 0 ' + width + ' ' + height,
		'role': 'group',
		'aria-label': _('Map'),
		'style': 'position:absolute;inset:0;display:block;touch-action:none'
	});
	defs = svgEl('defs', {});
	defs.appendChild(svgEl('marker', {
		'id': 'roamd-arrow-cable',
		'viewBox': '0 0 8 8',
		'markerWidth': 9,
		'markerHeight': 9,
		'refX': 6,
		'refY': 4,
		'orient': 'auto',
		'markerUnits': 'userSpaceOnUse'
	}, [ svgEl('path', { d: 'M0,1 L7,4 L0,7 Z', fill: MAP_THEME.cable }) ]));
	defs.appendChild(svgEl('marker', {
		'id': 'roamd-arrow-radio',
		'viewBox': '0 0 8 8',
		'markerWidth': 9,
		'markerHeight': 9,
		'refX': 6,
		'refY': 4,
		'orient': 'auto',
		'markerUnits': 'userSpaceOnUse'
	}, [ svgEl('path', { d: 'M0,1 L7,4 L0,7 Z', fill: MAP_THEME.radio }) ]));
	svg.appendChild(defs);
	world = svgEl('g', { 'class': 'roamd-map-world' });
	mapApplyCam(world);

	scene.edges.forEach(function(edge) {
		var radio = edge.kind === 'wifi';
		var stroke = radio ? MAP_THEME.radio : MAP_THEME.cable;
		var line = {
			x1: Math.round(edge.x1 * 10) / 10,
			y1: Math.round(edge.y1 * 10) / 10,
			x2: Math.round(edge.x2 * 10) / 10,
			y2: Math.round(edge.y2 * 10) / 10,
			fill: 'none',
			stroke: stroke,
			'stroke-width': 1.6,
			'stroke-linecap': 'butt',
			'vector-effect': 'non-scaling-stroke',
			'marker-end': radio ? 'url(#roamd-arrow-radio)' : 'url(#roamd-arrow-cable)',
			'pointer-events': 'none'
		};
		var textFill = MAP_THEME.metric;
		var group = svgEl('g', { 'class': 'roamd-map-connection' });

		edgeGroups.push({ edge: edge, el: group });
		world.appendChild(group);

		if (radio)
			line['stroke-dasharray'] = '6 5';

		if (edge.metricKind === 'dbm')
			textFill = MAP_THEME.metricRadio;
		else if (edge.metricKind === 'speed')
			textFill = MAP_THEME.speed;

		group.appendChild(svgEl('line', line));

		if (edge.metric) {
			group.appendChild(svgEl('text', {
				x: Math.round(edge.lx),
				y: Math.round(edge.ly),
				'text-anchor': 'middle',
				fill: textFill,
				'font-size': 11,
				'font-family': 'sans-serif',
				'pointer-events': 'none'
			}, [ edge.metric ]));
		}

		if (edge.active && motion) {
			var dot = svgEl('circle', {
				r: 2.5,
				fill: MAP_THEME.dot,
				stroke: 'none',
				'pointer-events': 'none'
			});

			dot.appendChild(svgEl('animate', {
				attributeName: 'cx',
				values: line.x1 + ';' + line.x2,
				dur: '1.6s',
				repeatCount: 'indefinite'
			}));
			dot.appendChild(svgEl('animate', {
				attributeName: 'cy',
				values: line.y1 + ';' + line.y2,
				dur: '1.6s',
				repeatCount: 'indefinite'
			}));
			group.appendChild(dot);
		}
	});

	scene.nodes.forEach(function(spec) {
		var fill = MAP_THEME.node;
		var stroke = MAP_THEME.nodeStroke;
		var halo = MAP_THEME.haloN;
		var g, hit;

		if (spec.kind === 'controller') {
			fill = MAP_THEME.star;
			stroke = MAP_THEME.starStroke;
			halo = MAP_THEME.haloC;
		} else if (spec.kind === 'client') {
			fill = spec.unknown ? MAP_THEME.unknown : MAP_THEME.client;
			stroke = MAP_THEME.clientStroke;
			halo = MAP_THEME.haloK;
		}

		if (!spec.online && !spec.unknown) {
			fill = MAP_THEME.bg;
			stroke = MAP_THEME.off;
		}

		g = svgEl('g', {
			'class': 'roamd-map-node',
			'data-key': spec.id,
			'role': extras[spec.id].actionable ? 'button' : null,
			'tabindex': extras[spec.id].actionable ? 0 : null,
			'aria-label': extras[spec.id].actionable ? extras[spec.id].tip : null,
			'style': extras[spec.id].actionable ? 'cursor:pointer' : null
		});
		nodeGroups.push({ id: spec.id, el: g });
		g.addEventListener('pointerenter', function(ev) {
			if (ev.pointerType !== 'touch') {
				hovered = spec.id;
				highlightBranch();
			}
		});
		g.addEventListener('pointerleave', function() {
			if (hovered === spec.id) {
				hovered = '';
				highlightBranch();
			}
		});
		g.addEventListener('focus', function() {
			focused = spec.id;
			highlightBranch();
		});
		g.addEventListener('blur', function() {
			focused = '';
			highlightBranch();
		});

		g.appendChild(svgEl('title', {}, [ (extras[spec.id] && extras[spec.id].tip) || spec.name || spec.mac || spec.id ]));
		halo = svgEl('circle', {
			cx: Math.round(spec.x),
			cy: Math.round(spec.y),
			r: spec.r + 8,
			fill: halo,
			stroke: 'none'
		});

		if (spec.active && motion) {
			halo.appendChild(svgEl('animate', {
				attributeName: 'opacity',
				values: '0.45;1;0.45',
				dur: '1.8s',
				repeatCount: 'indefinite'
			}));
		}

		g.appendChild(halo);

		if (spec.kind === 'controller')
			g.appendChild(svgEl('polygon', {
				points: mapGeomStar(spec.x, spec.y, spec.r, spec.r * 0.42, 5),
				fill: fill,
				stroke: stroke,
				'stroke-width': 1
			}));
		else if (spec.kind === 'node')
			g.appendChild(svgEl('rect', {
				x: Math.round(spec.x) - spec.r * 0.75,
				y: Math.round(spec.y) - spec.r * 0.75,
				width: spec.r * 1.5,
				height: spec.r * 1.5,
				rx: 4,
				fill: fill,
				stroke: stroke,
				'stroke-width': 1.5
			}));
		else
			g.appendChild(svgEl('circle', {
				cx: Math.round(spec.x),
				cy: Math.round(spec.y),
				r: spec.r,
				fill: fill,
				stroke: stroke,
				'stroke-width': 1.25
			}));

		(function drawLabel() {
			var label = spec.label;
			var text;

			if (!label)
				return;

			text = svgEl('text', {
				x: Math.round(label.x),
				y: Math.round(label.y),
				'text-anchor': label.anchor || 'middle',
				stroke: MAP_THEME.bg,
				'stroke-width': 3,
				'stroke-linejoin': 'round',
				'paint-order': 'stroke',
				'font-family': 'sans-serif'
			});
			(label.lines || []).forEach(function(line, i) {
				text.appendChild(svgEl('tspan', {
					x: Math.round(label.x),
					dy: i ? (label.lines[i - 1].size + 3) : 0,
					'class': line.secondary ? 'roamd-map-secondary' : null,
					'font-size': line.size,
					'font-weight': line.weight || 400,
					fill: line.fill
				}, [ line.text ]));
			});
			g.appendChild(text);
		})();

		hit = Math.max(spec.r + 10, 16);
		g.appendChild(svgEl('circle', {
			cx: Math.round(spec.x),
			cy: Math.round(spec.y),
			r: hit,
			fill: 'transparent',
			stroke: 'none'
		}));
		world.appendChild(g);
	});

	svg.appendChild(world);
	return svg;
}

function renderMeshMap(state, chrome) {
	var show = !!(mapShowClients && mapClientCache && !mapClientCache.failed);
	var graph = meshMapGraph(state);
	var byNode = show ? mapClientsByNode(state) : {};
	var hints = (mapClientCache && mapClientCache.hints) || {};
	var ov = (mapClientCache && mapClientCache.ov) || {};
	var self = state.self || {};
	var motion = mapRecentMotion(state);
	var items = [];
	var extras = {};
	var known = {};
	var scene, sig, overlay, stage, bar;

	chrome = chrome || {};

	items.push({
		id: 'controller',
		kind: 'controller',
		parent: '',
		name: state.controller_name || self.hostname || _('This device'),
		mac: self.mac || '',
		online: true,
		unknown: false,
		link: '',
		metric: '',
		metricKind: '',
		active: mapBridgeActive(self) || !!motion.nodes.controller
	});
	extras.controller = {
		kind: 'controller',
		actionable: true,
		tip: items[0].name
	};
	known.controller = true;

	(state.members || []).forEach(function(m) {
		var orphan, speed, parent, link, dbm, metric, kind;

		if (!m || !m.id || m.id === 'controller')
			return;

		orphan = (graph.orphans || []).indexOf(m.id) >= 0;
		parent = orphan ? '' : (graph.parentOf[m.id] || '');
		link = orphan ? '' : (m.connection === 'wifi' ? 'wifi' : (m.connection === 'wired' ? 'wired' : ''));
		dbm = link === 'wifi' ? mapUplinkRssi(m) : null;
		speed = mapBridgeSpeed(m);
		metric = speed || (link ? mapEdgeMetric(link, dbm) : '');
		kind = speed ? 'speed' : (dbm ? 'dbm' : '');
		items.push({
			id: m.id,
			kind: 'node',
			parent: parent,
			name: m.name || m.hostname || m.id,
			mac: m.mac || '',
			online: !!m.online,
			unknown: false,
			link: link,
			metric: metric,
			metricKind: kind,
			active: mapBridgeActive(m) || !!motion.nodes[m.id]
		});
		extras[m.id] = {
			kind: 'node',
			member: m,
			actionable: true,
			tip: (m.name || m.hostname || m.id) + (speed ? ' · ' + speed : '')
		};
		known[m.id] = true;
	});

	if (show) {
		Object.keys(byNode).forEach(function(pid) {
			if (known[pid])
				return;

			items.push({
				id: pid,
				kind: 'node',
				parent: '',
				name: pid,
				mac: '',
				online: true,
				unknown: false,
				link: '',
				metric: '',
				metricKind: '',
				active: !!motion.nodes[pid]
			});
			extras[pid] = { kind: 'node', tip: pid };
			known[pid] = true;
		});

		Object.keys(byNode).forEach(function(pid) {
			(byNode[pid] || []).forEach(function(c) {
				var parts = mapClientParts(c, hints, ov);
				var link = c.wired ? 'wired' : 'wifi';
				var dbm = link === 'wifi' ? mapClientRssi(c) : null;
				var speed = link === 'wifi' ? mapPhySpeed(c.rate) : '';
				var parent = known[pid] ? pid : 'controller';
				var macKey = String(c.mac || '').toLowerCase();
				var id = 'c:' + macKey;

				items.push({
					id: id,
					kind: 'client',
					parent: parent,
					name: parts.name,
					mac: c.mac || '',
					online: c.state !== 'unknown',
					unknown: c.state === 'unknown',
					link: link,
					metric: speed || mapEdgeMetric(link, dbm),
					metricKind: speed ? 'speed' : (dbm ? 'dbm' : ''),
					active: !!mapLive.macs[macKey] || !!motion.macs[macKey]
				});
				extras[id] = {
					kind: 'client',
					actionable: true,
					tip: parts.name ? '%s (%s)'.format(parts.name, c.mac) : (c.mac || '')
				};
			});
		});
	}

	scene = mapGeomLayout(items);
	sig = items.map(function(it) {
		return [ it.id, it.parent, it.kind, it.name, it.mac, it.link ].join(':');
	}).join('|');

	if (mapCam.sig !== sig) {
		mapCam.sig = sig;
		mapCam.user = false;
	}

	if (chrome.addButton && chrome.addButton.style)
		chrome.addButton.style.marginLeft = 'auto';

	bar = E('div', {
		'style': 'display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:8px 12px;background:var(--background-color-high, Canvas);color:var(--text-color-high, CanvasText);border-bottom:1px solid var(--border-color-medium, #767676)'
	}, [
		chrome.lead || '',
		nodesViewSwitch(),
		mapClientSwitch(),
		mapClientStatus(),
		mapZoomButton('+', _('Zoom in'), function() {
			var live = document.getElementById('roamd-map-overlay');

			if (live && live._zoom)
				live._zoom(1.2);
		}),
		mapZoomButton('−', _('Zoom out'), function() {
			var live = document.getElementById('roamd-map-overlay');

			if (live && live._zoom)
				live._zoom(1 / 1.2);
		}),
		mapZoomButton(_('Show all'), _('Show all'), function() {
			var live = document.getElementById('roamd-map-overlay');

			if (live && live._fit)
				live._fit();
		}),
		chrome.addButton || ''
	]);

	stage = E('div', {
		'class': 'roamd-map-stage',
		'style': 'position:relative;height:clamp(22rem, 76vh, 58rem);background-color:' + MAP_THEME.bg + ';background-image:radial-gradient(' + MAP_THEME.grid + ' 1px, transparent 1px);background-size:24px 24px;overflow:hidden;touch-action:none;cursor:grab;user-select:none'
	}, [
		mapLegend(),
		mapPaint(scene, extras)
	]);

	overlay = E('div', {
		'id': 'roamd-map-overlay',
		'style': 'border:1px solid var(--border-color-medium, #767676);border-radius:6px;overflow:hidden'
	}, [
		E('style', {}, mapOverlayCss()),
		chrome.deps || '',
		chrome.running || '',
		bar,
		stage
	]);
	overlay._bounds = scene.bounds;
	overlay._extras = extras;
	overlay._state = state;
	scheduleMapBind(overlay);
	return overlay;
}

function mapClientParts(c, hints, ov) {
	var name = '';

	if (c && c.mac) {
		try {
			name = common.clientLabel(hints || {}, ov || {}, c.mac) || '';
		} catch (e) {}
	}

	if (!name && c && c.host)
		name = usableClientName(c.host, c.mac);
	else
		name = usableClientName(name, c && c.mac);

	return { name: name || '', mac: (c && c.mac) || '' };
}

function mapOverlayCss() {
	var light = '' +
		'--roamd-map-bg:#f6f8fc;' +
		'--roamd-map-grid:#ccd5e3;' +
		'--roamd-map-star:#be3549;' +
		'--roamd-map-starstroke:#7b1d31;' +
		'--roamd-map-node:#2474b2;' +
		'--roamd-map-nodestroke:#174872;' +
		'--roamd-map-client:#548025;' +
		'--roamd-map-clientstroke:#335215;' +
		'--roamd-map-unknown:#a76118;' +
		'--roamd-map-off:#64748b;' +
		'--roamd-map-cable:#536880;' +
		'--roamd-map-radio:#a15a16;' +
		'--roamd-map-label:#172439;' +
		'--roamd-map-mac:#465870;' +
		'--roamd-map-metric:#465870;' +
		'--roamd-map-metricradio:#805019;' +
		'--roamd-map-speed:#245476;' +
		'--roamd-map-legend:#34465d;' +
		'--roamd-map-dot:#172439;' +
		'--roamd-map-haloc:rgba(190,53,73,0.16);' +
		'--roamd-map-halon:rgba(36,116,178,0.16);' +
		'--roamd-map-halok:rgba(84,128,37,0.14);';

	return ':root[data-darkmode="false"] .roamd-map-stage{' + light + '}' +
		'@media (prefers-color-scheme: light){:root:not([data-darkmode]) .roamd-map-stage{' + light + '}}' +
		'.roamd-map-world .roamd-map-muted{opacity:.32}' +
		'.roamd-map-highlight>line{stroke-width:2.6px}' +
		'.roamd-map-world:not(.roamd-map-detail) .roamd-map-secondary{opacity:0;pointer-events:none}' +
		'.roamd-map-world .roamd-map-node:hover .roamd-map-secondary,.roamd-map-world .roamd-map-node:focus .roamd-map-secondary{opacity:1}' +
		'#roamd-map-overlay .roamd-switch{display:inline-flex;padding:2px;border:1px solid #ccc;border-radius:999px;background:#f2f2f2}' +
		'#roamd-map-overlay .roamd-switch-opt{position:relative;margin:0;cursor:pointer}' +
		'#roamd-map-overlay .roamd-switch-opt input{position:absolute;opacity:0;width:1px;height:1px}' +
		'#roamd-map-overlay .roamd-switch-opt span{display:block;padding:.18rem .85rem;border-radius:999px;line-height:1.35;color:#222}' +
		'#roamd-map-overlay .roamd-switch-opt input:checked+span{background:#1f7a34;color:#fff;font-weight:600}' +
		'#roamd-map-overlay .roamd-switch-check{position:relative;display:inline-flex;align-items:center;gap:.45rem;margin:0;cursor:pointer;font-weight:600}' +
		'#roamd-map-overlay .roamd-switch-check input{position:absolute;opacity:0;width:1px;height:1px}' +
		'#roamd-map-overlay .roamd-switch-ui{display:inline-block;width:2.15rem;height:1.22rem;border-radius:999px;background:#c5c5c5;position:relative;flex:0 0 auto}' +
		'#roamd-map-overlay .roamd-switch-ui::after{content:"";position:absolute;top:.13rem;left:.13rem;width:.96rem;height:.96rem;border-radius:50%;background:#fff}' +
		'#roamd-map-overlay .roamd-switch-check input:checked+.roamd-switch-ui{background:#1f7a34}' +
		'#roamd-map-overlay .roamd-switch-check input:checked+.roamd-switch-ui::after{left:1.05rem}';
}

function preferText(pref) {
	if (pref === '2' || pref === '2.4' || pref === 'low')
		return _('2.4 GHz');
	if (pref === '5' || pref === 'high')
		return _('5 GHz');
	if (pref === '6')
		return _('6 GHz');

	return _('No preference');
}

function summaryStat(label, value) {
	return E('div', { 'class': 'roamd-stat' }, [
		E('span', { 'class': 'roamd-k' }, label),
		E('span', { 'class': 'roamd-v' }, value)
	]);
}

function statusMark(online) {
	return E('span', {
		'class': online ? 'roamd-state roamd-state-ok' : 'roamd-state roamd-state-off'
	}, online ? _('online') : _('offline'));
}

function roamingValue(m) {
	var issues;

	if (!m.online)
		return '—';

	if (!m.consistency || m.consistency === 'ok')
		return E('span', { 'class': 'roamd-state roamd-state-ok' }, _('works'));

	issues = (m.issues || []).map(function(i) { return ISSUE_TEXT[i] || i; }).join(', ');

	if (m.consistency === 'broken')
		return E('span', { 'class': 'roamd-state roamd-state-bad', 'title': issues }, _('roaming broken'));

	return E('span', { 'class': 'roamd-state roamd-state-warn', 'title': issues }, _('roaming degraded'));
}

function formatMbps(kbps) {
	var mb = Number(kbps) / 1000;

	if (!isFinite(mb) || mb < 0)
		return '0.0';

	if (mb >= 100)
		return String(Math.round(mb));

	return (Math.round(mb * 10) / 10).toFixed(1);
}

/* rx_kbps and tx_kbps are the live br-lan rate. Absent until the daemon has two samples. */
function throughputValue(src, online) {
	if (online === false || !src || src.rx_kbps == null || src.tx_kbps == null)
		return '—';

	return '↓ %s  ↑ %s %s'.format(
		formatMbps(src.rx_kbps), formatMbps(src.tx_kbps), _('Mbit/s'));
}

function memberCard(m, state) {
	var online = !!m.online;
	var action = E('button', {
		'class': 'btn cbi-button',
		'click': function() { nodeDialog(m, state, refreshNodes); }
	}, readOnly ? _('Details') : _('Settings'));
	var pills = [ E('span', { 'class': 'roamd-pill' }, _('node')) ];

	if (m.update_available)
		pills.push(E('span', { 'class': 'roamd-pill roamd-pill-warn' }, _('update available')));

	if (m.seg_issue)
		pills.push(E('span', { 'class': 'roamd-pill roamd-pill-warn' }, m.seg_issue));

	return E('article', { 'class': 'roamd-card roamd-node-card' + (online ? '' : ' roamd-card-off') }, [
		E('div', { 'class': 'roamd-card-head' }, [
			E('div', { 'class': 'roamd-card-id' }, [
				nameCell(m),
				E('div', { 'class': 'roamd-pills' }, pills)
			]),
			statusMark(online)
		]),
		common.facts([
			[ _('Client count'), clientCountLink(m.id, m.client_count) ],
			[ _('Throughput'), throughputValue(m, online) ],
			[ _('Uptime'), m.uptime ? '%t'.format(m.uptime) : '—' ],
			[ _('Via'), (function() {
				var via = viaLabel(m, state);
				return (!via || via === '-') ? '—' : via;
			})() ],
			[ _('Connection'), connectionCell(m) ],
			[ _('Roaming'), roamingValue(m) ]
		]),
		E('div', { 'class': 'roamd-card-actions' }, action)
	]);
}

function clientCountLink(id, count) {
	return E('button', {
		'class': 'roamd-link',
		'click': function(ev) {
			ev.preventDefault();
			openClients(id);
		}
	}, String(count || 0));
}

function connectionCell(m) {
	if (m.connection !== 'wifi')
		return m.connection === 'wired' ? _('Cable') : '-';

	var dbm = m.uplink_signal ? common.signed(m.uplink_signal) : 0;
	var label = m.uplink_band
		? '%s %s'.format(_('Wi-Fi'), common.bandLabel(m.uplink_band))
		: _('Wi-Fi');
	var head = dbm
		? E('span', {}, [ label + ': ', common.dbmText(m.uplink_signal, { serving: true }) ])
		: label;

	var parts = [];

	if (m.uplink_std)
		parts.push(m.uplink_std);
	if (m.uplink_nss)
		parts.push('%dx%d'.format(m.uplink_nss, m.uplink_nss));
	if (m.uplink_width)
		parts.push('%d %s'.format(m.uplink_width, _('MHz')));

	return E('div', {}, [
		E('div', {}, head),
		common.note(parts.join(' '))
	]);
}

function controllerDialog(state) {
	var self = state.self || {};
	var name = state.controller_name || '';
	var nameInput = E('input', {
		'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
		'value': name,
		'placeholder': self.hostname || _('This device'),
		'disabled': readOnly ? 'disabled' : null
	});
	var counts = state.counts || {};
	var info = [
		infoRow(_('Role'), _('controller')),
		infoRow(_('Clients'), String(state.controller_clients || 0)),
		infoRow(_('Throughput'), throughputValue(self, true)),
		infoRow(_('Nodes'), String(counts.nodes || 0)),
		infoRow(_('Uptime'), self.uptime ? '%t'.format(self.uptime) : '—'),
		infoRow(_('IP address'), self.addr || '—'),
		infoRow(_('MAC address'), self.mac || '—'),
		infoRow(_('System name'), self.hostname || '—'),
		infoRow(_('Software'), '%s / roamd %s'.format(self.os_version ? 'OpenWrt ' + self.os_version : '—',
			self.pkg_version || '—'))
	];

	if (state.deps_state)
		info.push(infoRow(_('Preparation'), state.deps_state));

	function save() {
		ui.hideModal();
		callMeshControllerName(nameInput.value).then(refreshNodes);
	}

	var actions = readOnly || state.auto_update ? [] : [
		E('button', {
			'class': 'btn cbi-button-apply',
			'click': function() { ui.hideModal(); checkSelfUpdate(); }
		}, _('Check for updates'))
	];

	var buttons = readOnly
		? [ E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')) ]
		: [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', { 'class': 'btn cbi-button-positive', 'click': save }, _('Save'))
		];

	common.showModal(state.controller_name || self.hostname || _('This device'), [
		E('h4', {}, _('Basic settings')),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, _('Controller name')),
			E('div', { 'class': 'cbi-value-field' }, nameInput)
		]),
		E('h4', {}, _('Details')),
		E('div', {}, info),
		common.dialogFooter(actions, buttons)
	]);
}

function controllerRoamingValue(status) {
	function value(text, style, detail) {
		return E('span', { 'class': 'roamd-state ' + style, 'title': detail || text }, text);
	}

	if (!status || typeof status.enabled !== 'boolean')
		return value(_('Roaming status unavailable'), 'roamd-state-warn');
	if (!status.enabled)
		return value(_('Roaming disabled'), 'roamd-state-off');

	var interfaces = Object.keys(status.interfaces || {}).map(function(name) {
		return { name: name, iface: status.interfaces[name] };
	}).filter(function(entry) { return entry.iface.active && entry.iface.managed; });

	if (!interfaces.length)
		return value(_('No active roaming interfaces'), 'roamd-state-warn');

	var broken = false, unknown = false, details = [];
	interfaces.forEach(function(entry) {
		var roaming = entry.iface.roaming;
		if (!roaming || ['ok', 'degraded', 'broken'].indexOf(roaming.state) < 0) {
			unknown = true;
			return;
		}
		broken = broken || roaming.state === 'broken';
		if (roaming.state !== 'ok')
			details.push(entry.name + ': ' + (roaming.issues || []).map(function(issue) {
				return CONTROLLER_ISSUE_TEXT[issue] || ISSUE_TEXT[issue] || issue;
			}).join(', '));
	});

	if (broken || details.length)
		return value(broken ? _('roaming broken') : _('roaming degraded'),
			broken ? 'roamd-state-bad' : 'roamd-state-warn', details.join('; '));
	if (unknown)
		return value(_('Roaming status unavailable'), 'roamd-state-warn');
	return value(_('works'), 'roamd-state-ok');
}

var CONTROLLER_ISSUE_TEXT = {
	no_peer: _('No matching radio interface'),
	disabled: _('A matching radio interface is disabled'),
	key: _('Wi-Fi passwords differ'),
	network: _('Networks differ'),
	no_11k: _('802.11k is disabled'),
	no_11v: _('802.11v is disabled'),
	fast_transition: _('802.11r settings differ'),
	no_neighbor_report: _('Neighbor report unavailable')
};

function controllerCard(state) {
	var self = state.self || {};
	var name = state.controller_name || self.hostname || _('This device');
	var check = E('button', {
		'class': 'btn cbi-button',
		'click': function() { controllerDialog(state); }
	}, readOnly ? _('Details') : _('Settings'));

	return E('article', { 'class': 'roamd-card roamd-node-card roamd-card-controller' }, [
		E('div', { 'class': 'roamd-card-head' }, [
			E('div', { 'class': 'roamd-card-id' }, [
				E('div', { 'class': 'roamd-title' }, name),
				E('div', { 'class': 'roamd-pills' }, [
					E('span', { 'class': 'roamd-pill' }, _('controller')),
					E('span', { 'class': 'roamd-pill' }, _('this device'))
				])
			]),
			E('span', { 'class': 'roamd-state roamd-state-ok', 'title': _('this device') }, _('online'))
		]),
		common.facts([
			[ _('Client count'), clientCountLink('controller', state.controller_clients) ],
			[ _('Throughput'), throughputValue(self, true) ],
			[ _('Uptime'), self.uptime ? '%t'.format(self.uptime) : '—' ],
			[ _('Roaming'), controllerRoamingValue(state.controller_roaming) ]
		]),
		E('div', { 'class': 'roamd-card-actions' }, check)
	]);
}

function checkSelfUpdate() {
	var body = E('div', {}, [
		E('p', { 'class': 'spinning' }, _('Checking the repository…')),
		E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': function() { cancel(); } }, _('Cancel')))
	]);

	common.showModal(_('Check for updates'), [ body ]);

	var cancel = runJob(callMeshSelfCheck, SELF_CHECK_LIMIT, function(res) {
		if (!res) {
			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, _('The check failed.')),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			return;
		}

		if (res.error || !res.packages) {
			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, _('The repository is unreachable.')),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			return;
		}

		var rows = res.packages.map(function(p) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, p.name),
				E('td', { 'class': 'td' }, p.installed || '-'),
				E('td', { 'class': 'td' }, p.available || '-'),
				E('td', { 'class': 'td' }, p.outdated ? E('strong', { 'style': 'color:#c60' }, _('update available')) : _('up to date'))
			]);
		});

		var buttons = [ E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')) ];

		if (res.update_available && !readOnly)
			buttons.push(' ', E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function() { startSelfUpdate(body); }
			}, _('Update the controller')));

		dom.content(body, [
			E('p', {}, res.update_available
				? _('A newer version is available. The controller can install it itself.')
				: _('This device runs the newest packages from the repository.')),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Package')),
					E('th', { 'class': 'th' }, _('Installed')),
					E('th', { 'class': 'th' }, _('Repository')),
					E('th', { 'class': 'th' }, '')
				])
			].concat(rows)),
			E('div', { 'class': 'right' }, buttons)
		]);
	});
}

function startSelfUpdate(body) {
	dom.content(body, E('p', { 'class': 'spinning' }, _('Installing the packages…')));

	callMeshSelfUpdate().then(function(res) {
		res = res || {};

		if (res.error && !res.task_id) {
			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, acquireErrText(res.error)),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			return;
		}

		pollAcquire(res.task_id, body, 0, 'selfupdate');
	});
}

function nameCell(m) {
	var alias = m.name || m.hostname || m.id;
	var sys = (m.hostname && m.hostname !== alias) ? m.hostname : '';
	var link = nodeUiOpen && m.addr ? E('a', {
		'href': 'http://%s/'.format(m.addr),
		'target': '_blank',
		'rel': 'noreferrer',
		'class': 'roamd-link',
		'title': _('Open the node web interface'),
		'style': 'margin-left:.4em'
	}, _('web')) : '';

	return common.twoLine(E('div', {}, [ E('strong', {}, alias), link ]), sys);
}

function replaceNodes(state) {
	var pane = document.getElementById('mesh-nodes-pane');
	var focused = document.activeElement;
	var key = pane && pane.contains(focused) && focused.getAttribute('data-key');

	if (mapObserver) {
		mapObserver.disconnect();
		mapObserver = null;
	}

	if (!pane)
		return;

	dom.content(pane, renderNodes(state || {}));

	if (key) {
		var nodes = pane.querySelectorAll('[data-key][tabindex]');

		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].getAttribute('data-key') === key) {
				nodes[i].focus({ preventScroll: true });
				break;
			}
		}
	}
}

function refreshNodes() {
	return meshStatusWithRoaming().then(function(fresh) {
		fresh = fresh || {};
		replaceNodes(fresh);
		settingsSync(fresh);
		return ensureMapClients();
	});
}

function bssidOwner(bssid, aps) {
	for (var i = 0; i < (aps || []).length; i++)
		if (aps[i].bssid === bssid)
			return true;

	return false;
}

function viaLabel(m, state) {
	if (!m.online || !m.via)
		return '-';

	if (m.via === 'controller' || bssidOwner(m.via, state.self_aps))
		return controllerLabel(state);

	var members = state.members || [];

	for (var i = 0; i < members.length; i++)
		if (bssidOwner(m.via, members[i].aps))
			return members[i].name;

	return m.via;
}

function removeMember(id, name) {
	var reset = E('input', { 'type': 'checkbox', 'checked': 'checked' });

	common.showModal(_('Remove the node'), [
		E('p', {}, _('Remove the node %s from the Wi-Fi system?').format(name || id)),
		E('label', { 'class': 'cbi-value', 'style': 'display:block' }, [
			reset, ' ', _('Reset the device to factory settings')
		]),
		E('p', { 'class': 'cbi-value-description' },
			_('With the reset the device becomes independent again and can be captured anew. Without it the controller only stops managing the device, and it keeps working with the profile it has already received.')),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-remove',
				'click': function() {
					var wipe = reset.checked;
					var body = E('div', {}, E('p', { 'class': 'spinning' }, _('Removing %s…').format(name || id)));

					ui.hideModal();
					common.showModal(_('Remove the node'), [ body ]);

					if (!wipe) {
						callMeshMemberRemove(id).then(function() { location.reload(); });
						return;
					}

					callMeshMemberRemove(id, '1').then(function(res) {
						res = res || {};

						if (res.error && !res.task_id) {
							dom.content(body, [
								E('p', { 'class': 'alert-message warning' }, acquireErrText(res.error)),
								E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); location.reload(); } }, _('Close')))
							]);
							return;
						}

						pollAcquire(res.task_id, body, 0, 'release');
					});
				}
			}, _('Remove'))
		])
	]);
}

function updateMember(id, name) {
	var body = E('div', {}, [ E('p', { 'class': 'spinning' }, _('Updating %s…').format(name || id)) ]);
	common.showModal(_('Updating the node'), [ body ]);

	callMeshUpdate(id).then(function(res) {
		if (res && res.error) {
			dom.content(body, [
				E('p', { 'class': 'alert-message warning' }, acquireErrText(res.error)),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
			return;
		}
		pollAcquire(res.task_id, body, 0, 'update');
	});
}

function renderLog() {
	var filters = { mac: '', from: '', to: '', type: '' };
	var all = [];

	var list = E('div', { 'class': 'roamd-events' });
	var counter = E('span', { 'class': 'cbi-value-description' }, '');

	function refresh() {
		var shown = all.filter(function(ev) {
			var mac = (ev.mac || '').toLowerCase();
			var name = (logNames[mac] || '').toLowerCase();
			var needle = filters.mac.toLowerCase();

			if (filters.mac && mac.indexOf(needle) < 0 && name.indexOf(needle) < 0) return false;
			if (filters.from && (ev.from_node || '').toLowerCase().indexOf(filters.from.toLowerCase()) < 0) return false;
			if (filters.to && (ev.to_node || '').toLowerCase().indexOf(filters.to.toLowerCase()) < 0) return false;
			if (filters.type && ev.type !== filters.type) return false;
			return true;
		});

		counter.textContent = _('Showing %d of %d records').format(shown.length, all.length);
		dom.content(list, shown.length
			? shown.map(logItem)
			: E('em', {}, _('The transition log is empty')));
	}

	function filterInput(key, ph) {
		return E('input', {
			'type': 'text', 'placeholder': ph, 'aria-label': ph, 'style': 'width:9em',
			'keyup': function(ev) { filters[key] = ev.target.value; refresh(); }
		});
	}

	var typeSelect = E('select', {
		'aria-label': _('Type'),
		'change': function(ev) { filters.type = ev.target.value; refresh(); }
	}, [
		E('option', { 'value': '' }, _('all types')),
		E('option', { 'value': 'roam' }, _('roaming')),
		E('option', { 'value': 'steer' }, _('steering')),
		E('option', { 'value': 'connect' }, _('connected')),
		E('option', { 'value': 'disconnect' }, _('disconnected')),
		E('option', { 'value': 'kick' }, _('forced disconnect')),
		E('option', { 'value': 'deny-node' }, _('device not allowed')),
		E('option', { 'value': 'deny-band' }, _('band not allowed'))
	]);

	var bar = E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin-bottom:.5em;flex-wrap:wrap' }, [
		filterInput('mac', _('Client')),
		filterInput('from', _('From')),
		filterInput('to', _('To')),
		typeSelect,
		counter,
		E('button', {
			'class': 'btn cbi-button', 'style': 'margin-left:auto',
			'click': function() { downloadCsv(all); }
		}, _('Download CSV'))
	]);

	var container = E('div', {}, [
		E('p', {}, _('Client transitions between the nodes of the Wi-Fi system are shown here.')),
		bar, list
	]);

	function load() {
		return callMeshLog().then(function(events) {
			all = events || [];
			refresh();
		}, function() {});
	}

	Promise.all([
		common.hostHints(),
		uci.load('roamd').catch(function() { return null; })
	]).then(function(res) {
		var ov = common.deviceOverrides();

		logNames = {};
		for (var mac in (res[0] || {}))
			logNames[mac.toLowerCase()] = common.hostName(res[0], mac);
		for (var m in ov)
			if (ov[m].alias)
				logNames[m] = ov[m].alias;

		return load();
	}).then(function() {
		poll.add(load, 5);
	});

	return container;
}

function humanBytes(n) {
	var units = [ _('B'), _('KB'), _('MB'), _('GB'), _('TB') ];
	var i = 0;

	n = Number(n) || 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}

	return '%s %s'.format(i ? n.toFixed(2) : String(n), units[i]);
}

function hintIp4(hints, mac) {
	var h = hints[mac.toUpperCase()] || hints[mac.toLowerCase()] || {};

	if (h.ipaddrs && h.ipaddrs.length)
		return h.ipaddrs[0];

	return h.ipv4 || '';
}

function hintIp6(hints, mac) {
	var h = hints[mac.toUpperCase()] || hints[mac.toLowerCase()] || {};

	if (h.ip6addrs && h.ip6addrs.length)
		return h.ip6addrs;

	return h.ipv6 ? [ h.ipv6 ] : [];
}

function bandLockLabel(band) {
	if (band === '2')
		return _('only 2.4 GHz');
	if (band === '5')
		return _('only 5 GHz');

	return _('both bands');
}

var readOnly = false;

function infoRow(label, value) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, value)
	]);
}

function bandChoice(current) {
	var opts = [
		{ value: 'both', label: _('both bands') },
		{ value: '2', label: _('only 2.4 GHz') },
		{ value: '5', label: _('only 5 GHz') }
	];

	return opts.map(function(o) {
		var input = E('input', {
			'type': 'radio', 'name': 'roamd-band', 'value': o.value,
			'checked': (current || 'both') === o.value ? 'checked' : null,
			'disabled': readOnly ? 'disabled' : null
		});

		return E('label', { 'style': 'margin-right:1.5em' }, [ input, ' ', o.label ]);
	});
}

function nodeChips(allNodes, allowed) {
	var state = {};

	allNodes.forEach(function(n) {
		state[n.id] = !allowed.length || allowed.indexOf(n.id) >= 0;
	});

	var chips = allNodes.map(function(n) {
		var chip = E('button', {
			'class': 'btn',
			'style': 'margin:0 .4em .4em 0',
			'click': function(ev) {
				ev.preventDefault();
				if (readOnly)
					return;
				state[n.id] = !state[n.id];
				paint(chip, n.id);
			}
		});

		paint(chip, n.id);
		return chip;
	});

	function paint(chip, id) {
		var on = state[id];
		var label = allNodes.filter(function(n) { return n.id === id; })[0].label;

		chip.style.background = on ? '' : '#777';
		chip.style.color = on ? '' : '#fff';
		dom.content(chip, on ? label : [ label, ' ✕' ]);
	}

	return {
		widget: E('div', {}, chips),
		value: function() {
			var on = allNodes.filter(function(n) { return state[n.id]; })
				.map(function(n) { return n.id; });

			return on.length === allNodes.length ? '' : on.join(',');
		},
		reset: function() {
			allNodes.forEach(function(n) { state[n.id] = true; });
			chips.forEach(function(chip, i) { paint(chip, allNodes[i].id); });
		}
	};
}

var SIGNAL_FRESH = 90;

function signalLine(band, signal, age, serving) {
	var stale = (age || 0) > SIGNAL_FRESH;
	var dbm = common.signed(signal);

	if (!dbm)
		return '';

	return E('div', {}, [
		common.bandLabel(band) + ' — ',
		common.dbmText(signal, { serving: serving, stale: stale })
	]);
}

/* 6 GHz has its own RSSI slot. It is not drawn on the 5 GHz line. */
function signalBlock(c) {
	if (!c || (!c.signal_24 && !c.signal_5 && !c.signal_6))
		return null;

	function serving(band) {
		return common.bandKind(c.band) === common.bandKind(band);
	}

	return E('div', {}, [
		signalLine('2.4', c.signal_24, c.signal_24_age, serving('2.4')),
		signalLine('5', c.signal_5, c.signal_5_age, serving('5')),
		signalLine('6', c.signal_6, c.signal_6_age, serving('6'))
	]);
}

function clientDialog(c, hints, ov, allNodes, refresh) {
	var mac = c.mac.toLowerCase();
	var saved = ov[mac] || { band: 'both', alias: '', nodes: [] };
	var sysName = usableClientName(c.host, c.mac) || usableClientName(common.hostName(hints, c.mac), c.mac);
	var title = clientAnnouncedName(c, hints, ov) || c.mac;
	var nameInput = E('input', {
		'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
		'value': saved.alias || '',
		'placeholder': sysName,
		'disabled': readOnly ? 'disabled' : null
	});
	var bands = bandChoice(saved.band);
	var chips = nodeChips(allNodes, saved.nodes);
	var ip4 = hintIp4(hints, c.mac);
	var conn = !clientSeen(c) ? _('offline')
		: c.wired ? _('Cable')
		: _('Wi-Fi %s GHz').format(c.band || '?');
	var info = [
		infoRow(_('Device name'), sysName || '—'),
		infoRow(_('Connection'), conn),
		infoRow(_('MAC address'), c.mac)
	];

	if (ip4)
		info.push(infoRow(_('IP address'), ip4));
	var signals = signalBlock(c);

	if (signals)
		info.push(infoRow(_('Signal'), signals));
	if (c.rate)
		info.push(infoRow(_('Rate'), '%d %s'.format(Math.round(c.rate / 1000), _('Mbit/s'))));
	if (c.rx_bytes || c.tx_bytes) {
		info.push(infoRow(_('Received by client'), humanBytes(c.rx_bytes)));
		info.push(infoRow(_('Sent by client'), humanBytes(c.tx_bytes)));
	}

	function save() {
		ui.hideModal();
		callMeshClientUpdate(c.mac, bands.filter(function(l) { return l.firstChild.checked; })
			.map(function(l) { return l.firstChild.value; })[0] || 'both',
			nameInput.value, chips.value()).then(refresh);
	}

	function forget() {
		ui.hideModal();
		callMeshClientForget(c.mac).then(refresh);
	}

	var buttons = readOnly
		? [ E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')) ]
		: [
			E('button', { 'class': 'btn cbi-button-remove', 'style': 'float:left',
				'click': forget }, _('Forget device')),
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', { 'class': 'btn cbi-button-positive', 'click': save }, _('Save'))
		];

	common.showModal(title, [
		E('h4', {}, _('Basic settings')),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, _('Client name')),
			E('div', { 'class': 'cbi-value-field' }, nameInput)
		]),
		c.wired ? '' : E('h4', {}, _('Wi-Fi bands allowed for this device')),
		c.wired ? '' : E('div', { 'class': 'cbi-value' }, bands),
		c.band_lock && !c.band_lock_active
			? E('div', { 'class': 'alert-message warning' },
				_('The rule is not in effect: the Wi-Fi system has no access points in this band.'))
			: '',
		c.no_place && c.band_lock_active
			? E('div', { 'class': 'alert-message warning' },
				_('The rule is in effect, but no access point of the Wi-Fi system is allowed for this device right now.'))
			: '',
		c.wired ? '' : E('h4', {}, _('Wi-Fi system nodes allowed for this device')),
		c.wired ? '' : E('div', { 'class': 'cbi-value' }, chips.widget),
		readOnly || c.wired ? '' : E('div', { 'class': 'cbi-value' }, E('button', {
			'class': 'btn',
			'click': function(ev) {
				ev.preventDefault();
				chips.reset();
				bands.forEach(function(l) { l.firstChild.checked = l.firstChild.value === 'both'; });
			}
		}, _('Restore default roaming'))),
		E('h4', {}, _('Details')),
		E('div', {}, info),
		E('div', { 'class': 'right' }, buttons)
	]);
}

function nodeDialog(m, state, refresh) {
	var title = m.name || m.hostname || m.id;
	var nameInput = E('input', {
		'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
		'value': m.name || '',
		'placeholder': m.hostname || m.id,
		'disabled': readOnly ? 'disabled' : null
	});
	var parents = (state.members || [])
		.filter(function(o) { return o.id !== m.id; })
		.map(function(o) { return { id: o.id, label: o.name || o.hostname || o.id }; });

	parents.unshift({ id: 'controller', label: controllerLabel(state) });

	var chips = nodeChips(parents, m.bh_nodes ? m.bh_nodes.split('-') : []);
	var conn = m.connection === 'wifi'
		? (m.uplink_band ? _('Wi-Fi %s GHz').format(m.uplink_band) : _('Wi-Fi'))
		: (m.connection === 'wired' ? _('Cable') : '—');
	var info = [
		infoRow(_('Status'), m.online ? _('online') : _('offline')),
		infoRow(_('Connection'), conn),
		infoRow(_('Via'), viaLabel(m, state) || '—'),
		infoRow(_('Clients'), String(m.client_count || 0)),
		infoRow(_('Throughput'), throughputValue(m, !!m.online)),
		infoRow(_('Uptime'), m.uptime ? '%t'.format(m.uptime) : '—'),
		infoRow(_('IP address'), m.addr || '—'),
		infoRow(_('MAC address'), m.mac || '—'),
		infoRow(_('System name'), m.hostname || '—'),
		infoRow(_('Software'), '%s / roamd %s%s'.format(m.os_version ? 'OpenWrt ' + m.os_version : '—',
			m.pkg_version || '—', m.update_available ? ' ⬆' : ''))
	];

	if (m.connection === 'wifi' && common.signed(m.uplink_signal))
		info.splice(2, 0, infoRow(_('Uplink signal'), '%d %s'.format(common.signed(m.uplink_signal), _('dBm'))));

	if (m.consistency && m.consistency !== 'ok')
		info.push(infoRow(_('Profile check'), m.issues || m.consistency));

	if (m.seg_issue)
		info.push(infoRow(_('Segment'), m.seg_issue));

	function save() {
		ui.hideModal();
		callMeshMemberUpdate(m.id, nameInput.value, chips.value()).then(refresh);
	}

	var busy = state.acquire && state.acquire.running;
	var actions = readOnly ? [] : [
		m.update_available ? E('button', {
			'class': 'btn cbi-button-apply',
			'style': 'margin-right:.4em',
			'disabled': busy ? 'disabled' : null,
			'title': busy ? _('another task is running') : _('update available'),
			'click': function() { ui.hideModal(); updateMember(m.id, m.name); }
		}, _('Update')) : '',
		E('button', {
			'class': 'btn cbi-button-remove',
			'click': function() { ui.hideModal(); removeMember(m.id, m.name); }
		}, _('Remove node'))
	];

	var buttons = readOnly
		? [ E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')) ]
		: [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', { 'class': 'btn cbi-button-positive', 'click': save }, _('Save'))
		];

	common.showModal(title, [
		E('h4', {}, _('Basic settings')),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, _('Node name')),
			E('div', { 'class': 'cbi-value-field' }, nameInput)
		]),

		E('h4', {}, _('Wireless uplink of this node')),
		E('p', { 'class': 'cbi-value-description' },
			_('Applies to the wireless link only. A cable uplink is always allowed and is always preferred.')),
		E('div', { 'class': 'cbi-value' }, chips.widget),
		m.bh_nodes_void
			? E('div', { 'class': 'alert-message warning' },
				_('None of the allowed devices is reachable for this node, so the limit is not applied.'))
			: '',
		readOnly ? '' : E('div', { 'class': 'cbi-value' }, E('button', {
			'class': 'btn',
			'click': function(ev) {
				ev.preventDefault();
				chips.reset();
			}
		}, _('Allow any device'))),

		E('h4', {}, _('Details')),
		E('div', {}, info),
		common.dialogFooter(actions, buttons)
	]);
}

function controllerLabel(state) {
	return (state && state.controller_name) || _('controller');
}

function viaNodeLabel(c, nodeName) {
	return nodeName[c.node || 'controller'] || c.node || _('controller');
}

/* host is the name the daemon already published (DHCP lease, or mDNS / rDNS
 * handed back through mesh_client_host). A manual alias still wins. */
function usableClientName(name, mac) {
	name = String(name || '').trim();
	if (!name || name === '*')
		return '';
	if (mac && name.toLowerCase() === String(mac).toLowerCase())
		return '';

	return name;
}

function clientAnnouncedName(c, hints, ov) {
	var mac = c.mac || '';
	var saved = (ov && ov[mac.toLowerCase()]) || {};

	return usableClientName(saved.alias, mac) ||
		usableClientName(c.host, mac) ||
		usableClientName(common.hostName(hints, mac), mac);
}

function clientHead(c, name, state) {
	var dot = E('span', {
		'class': 'roamd-dot',
		'style': 'background:%s'.format(state.color),
		'title': state.label
	});

	if (!name)
		return E('div', {}, [ dot, E('strong', {}, c.mac || '') ]);

	return E('div', { 'class': 'roamd-id' }, [
		E('div', { 'class': 'roamd-id-line' }, [ dot, E('strong', {}, name) ]),
		E('div', { 'class': 'roamd-id-mac' }, c.mac || '')
	]);
}

function clientTitle(c, hints, ov) {
	var alias = common.clientLabel(hints, ov, c.mac) || c.host || c.mac;
	var state = clientState(c);

	return E('div', { 'class': 'roamd-title' }, [
		E('span', {
			'class': 'roamd-dot',
			'style': 'background:%s'.format(state.color),
			'title': state.label
		}),
		alias
	]);
}

function addrCell(c, hints) {
	var lines = [];

	if (clientSeen(c)) {
		var ip4 = hintIp4(hints, c.mac);

		if (ip4)
			lines.push(E('div', {}, ip4));
		hintIp6(hints, c.mac).forEach(function(a) {
			lines.push(common.note(a, '#2196a5'));
		});
	}

	lines.push(common.note(c.mac));

	return E('div', {}, lines);
}

function clientPlace(c, nodeName) {
	var bandText = '';
	var kind = 'wire';

	if (c.wired)
		bandText = _('Cable');
	else if (clientSeen(c)) {
		bandText = _('Wi-Fi %s GHz').format(c.band || '?');
		kind = common.bandKind(c.band);
	}

	return E('div', { 'class': 'roamd-where' }, [
		E('div', {}, [
			E('div', { 'class': 'roamd-k' }, _('Through node')),
			E('div', { 'class': 'roamd-where-name' },
				clientSeen(c) ? viaNodeLabel(c, nodeName) : '—')
		]),
		bandText ? E('div', { 'class': 'roamd-band roamd-band-' + kind }, bandText) : ''
	]);
}

function clientFacts(c, hints, ov) {
	var mac = c.mac.toLowerCase();
	var lock = (ov[mac] && ov[mac].band) || 'both';
	var state = clientState(c);
	var rows = [ [ _('Address'), addrCell(c, hints) ] ];

	if (!c.wired)
		rows.push([ _('Connection'), E('div', {}, [
			E('span', {}, bandLockLabel(lock)),
			c.no_place ? common.note(_('no allowed access point'), '#c44') : ''
		]) ]);

	var signals = signalBlock(c);

	if (clientSeen(c) && signals)
		rows.push([ _('Signal'), signals ]);

	if (clientSeen(c) && c.rate)
		rows.push([ _('Parameters'), paramCell(c) ]);

	if (clientSeen(c) && (c.rx_bytes || c.tx_bytes))
		rows.push([ _('Traffic'), trafficCell(c) ]);

	if (c.state !== 'online')
		rows.push([ _('Status'), E('span', {
			'class': 'roamd-state ' + (c.state === 'unknown' ? 'roamd-state-warn' : 'roamd-state-off')
		}, state.label) ]);

	return common.facts(rows);
}

function paramCell(c) {
	if (!clientSeen(c) || !c.rate)
		return '—';

	var phy = c.std || '';
	if (c.nss)
		phy += ' %dx%d'.format(c.nss, c.nss);
	if (c.width)
		phy += ' %d %s'.format(c.width, _('MHz'));

	return common.twoLine(E('div', {}, [
		E('strong', {}, '%d %s'.format(Math.round(c.rate / 1000), _('Mbit/s'))),
		c.encryption ? ' ' + c.encryption : ''
	]), phy);
}

function trafficCell(c) {
	if (!clientSeen(c) || (!c.rx_bytes && !c.tx_bytes))
		return '—';

	return E('div', {}, [
		E('div', {}, '↓ %s'.format(humanBytes(c.rx_bytes))),
		E('div', {}, E('small', {}, '↑ %s'.format(humanBytes(c.tx_bytes))))
	]);
}

function servingSample(c) {
	var kind = common.bandKind(c.band);

	if (!c.band)
		return null;

	if (kind === '2')
		return { value: c.signal_24, age: c.signal_24_age };
	if (kind === '6')
		return { value: c.signal_6, age: c.signal_6_age };

	return { value: c.signal_5, age: c.signal_5_age };
}

function clientRow(c, hints, ov, nodeName, allNodes, refresh) {
	var name = clientAnnouncedName(c, hints, ov);
	var state = clientState(c);
	var seen = clientSeen(c);
	var sample = (!c.wired && seen) ? servingSample(c) : null;
	var stale = sample && (sample.age || 0) > SIGNAL_FRESH;
	var band = c.wired ? _('Cable') : (seen && c.band ? _('Wi-Fi %s GHz').format(c.band) : '—');
	var traffic = (seen && (c.rx_bytes || c.tx_bytes)) ? '↓ %s'.format(humanBytes(c.rx_bytes)) : '';
	var badge = '';
	var action = E('button', {
		'class': 'btn cbi-button',
		'click': function() { clientDialog(c, hints, ov, allNodes, refresh); }
	}, readOnly ? _('Details') : _('Settings'));

	if (!seen)
		badge = E('span', { 'class': 'roamd-pill' }, state.label);
	else if (c.state === 'unknown')
		badge = E('span', { 'class': 'roamd-pill roamd-pill-warn' }, state.label);
	else if (c.no_place)
		badge = E('span', { 'class': 'roamd-pill roamd-pill-warn' }, _('no allowed access point'));

	return E('div', { 'class': 'roamd-row' + (seen ? '' : ' roamd-row-off') }, [
		E('div', { 'class': 'roamd-row-main' }, [
			clientHead(c, name, state),
			seen ? '' : common.note(viaNodeLabel(c, nodeName))
		]),
		E('span', {}, band),
		sample ? common.dbmText(sample.value, { serving: true, stale: stale }) : E('span', { 'class': 'roamd-muted' }, '—'),
		traffic ? E('span', { 'class': 'roamd-muted' }, traffic) : '',
		badge,
		action
	]);
}

function serviceMacs(members) {
	var set = {};

	(members || []).forEach(function(m) {
		if (!m.mac)
			return;

		var mac = m.mac.toLowerCase();
		var head = parseInt(mac.slice(0, 2), 16);

		set[mac] = true;
		set['%02x%s'.format(head ^ 0x02, mac.slice(2))] = true;
	});

	return set;
}

function clientNodeChoices(state) {
	return [ { id: 'controller', label: controllerLabel(state) } ].concat(
		(state.members || []).map(function(m) {
			return { id: m.id, label: m.name || m.hostname || m.id };
		}));
}

function renderClients(state) {
	var members = state.members || [];
	var nodeName = {};
	var nodeOnline = {};

	members.forEach(function(m) {
		nodeName[m.id] = m.name || m.hostname || m.id;
		nodeOnline[m.id] = !!m.online;
	});
	nodeName.controller = controllerLabel(state);
	nodeNames = Object.assign({}, nodeName);

	var allNodes = clientNodeChoices(state);
	var board = E('div', { 'id': 'mesh-clients-board' });

	function groupOrder(ids) {
		var ordered = [];

		if (ids.controller)
			ordered.push('controller');

		members.forEach(function(m) {
			if (ids[m.id])
				ordered.push(m.id);
		});

		for (var id in ids)
			if (ordered.indexOf(id) < 0)
				ordered.push(id);

		return ordered;
	}

	function groupHead(id, count) {
		return E('div', { 'class': 'roamd-group-head' }, [
			E('span', { 'class': 'roamd-title' }, nodeName[id] || id),
			E('span', { 'class': 'roamd-muted' }, String(count))
		]);
	}

	function refresh() {
		uci.unload('roamd');

		return Promise.all([
			callMeshClients().catch(function() { return {}; }),
			common.hostHints(),
			uci.load('roamd').catch(function() { return null; })
		]).then(function(res) {
			var clients = (res[0] && res[0].clients) || res[0] || [];
			var hints = res[1] || {};
			var ov = common.deviceOverrides();
			var service = serviceMacs(members);
			var byNode = {};
			var down = [];
			var sections = [];

			clients.forEach(function(c) {
				var mac = c.mac.toLowerCase();
				var id;

				if (service[mac])
					return;

				if (!clientSeen(c)) {
					down.push(c);
					return;
				}

				id = c.node || 'controller';
				(byNode[id] || (byNode[id] = [])).push(c);
			});

			if (clientFocus) {
				var focused = {};

				if (byNode[clientFocus])
					focused[clientFocus] = byNode[clientFocus];

				byNode = focused;
				down = down.filter(function(c) {
					return (c.node || 'controller') === clientFocus;
				});
				sections.push(E('p', { 'class': 'roamd-lead' }, [
					nodeName[clientFocus] || clientFocus,
					' · ',
					E('button', {
						'class': 'roamd-link',
						'click': function(ev) { ev.preventDefault(); openClients(''); }
					}, _('All nodes'))
				]));
			}

			sections.push(E('h4', {}, _('Online')));

			if (!groupOrder(byNode).length)
				sections.push(E('p', {}, E('em', {}, _('No clients online'))));

			groupOrder(byNode).forEach(function(id) {
				var list = byNode[id];

				sections.push(E('section', { 'class': 'roamd-group' }, [
					groupHead(id, list.length),
					E('div', { 'class': 'roamd-rows' }, list.map(function(c) {
						return clientRow(c, hints, ov, nodeName, allNodes, refresh);
					}))
				]));
			});

			if (down.length) {
				sections.push(E('h4', {}, _('Offline')));
				sections.push(E('div', { 'class': 'roamd-rows' }, down.map(function(c) {
					return clientRow(c, hints, ov, nodeName, allNodes, refresh);
				})));
			}

			dom.content(board, sections);
		});
	}

	refreshClients = refresh;
	refresh();
	poll.add(refresh, 5);

	return board;
}

var AUTO_UNITS = [
	{ unit: 'hour', label: _('hours'), max: 23 },
	{ unit: 'day', label: _('days'), max: 31 },
	{ unit: 'week', label: _('weeks'), max: 5 },
	{ unit: 'month', label: _('months'), max: 12 }
];

var AUTO_RESULT = {
	updated: _('updated'),
	none: _('no updates'),
	error: _('the update failed')
};

function lastCheckText(state) {
	var pad = function(n) { return (n < 10 ? '0' : '') + n; };
	var d, when, result;

	if (!state.auto_update_last)
		return _('not performed yet');

	d = new Date(state.auto_update_last * 1000);
	when = '%s-%s-%s %s:%s'.format(pad(d.getDate()), pad(d.getMonth() + 1),
		d.getFullYear(), pad(d.getHours()), pad(d.getMinutes()));
	result = AUTO_RESULT[state.auto_update_result];

	return result ? '%s — %s'.format(when, result) : when;
}

var BACKHAUL_FIELDS = [ 'backhaul_ssid', 'backhaul_key' ];
var settingsSync;

function bandsLabel(bands) {
	var list = [];

	if (bands & 1)
		list.push(common.bandLabel('2.4'));
	if (bands & 2)
		list.push(common.bandLabel('5'));
	/* Mesh bit 0x4 is 6 GHz, separate from the 5 GHz bit. */
	if (bands & 4)
		list.push(common.bandLabel('6'));

	return list.length ? list.join(', ') : '—';
}

function renderNetworks(state) {
	var nets = state.networks || [];
	var status = E('span', { 'style': 'margin-left:1em' });
	var cards = nets.map(function(net) {
		var box = E('input', {
			'type': 'checkbox',
			'checked': net.roaming ? 'checked' : null,
			'disabled': readOnly || null,
			'change': function(ev) {
				var on = ev.target.checked;

				status.textContent = _('Saving…');
				callMeshNetworkUpdate(net.ssid, on ? '1' : '0').then(function() {
					status.textContent = _('Saved.');
				}, function() {
					ev.target.checked = !on;
					status.textContent = _('Save failed.');
				});
			}
		});

		return E('article', { 'class': 'roamd-card' }, [
			E('div', { 'class': 'roamd-card-head' }, [
				E('div', { 'class': 'roamd-title' }, net.ssid),
				E('label', { 'class': 'roamd-toggle' }, [ box, ' ', _('Roaming') ])
			]),
			common.facts([
				[ _('Security'), net.encryption || 'none' ],
				[ _('Bands'), bandsLabel(net.bands || 0) ],
				[ _('On the nodes'), net.segment
					? _('segment %d: over the wireless backhaul, and over cable on nodes without a shared switch').format(net.vid || 0)
					: _('yes') ]
			])
		]);
	});

	return E('div', {}, [
		E('h3', {}, _('Wireless networks')),
		E('p', { 'class': 'cbi-value-description' },
			_('The nodes broadcast the same networks as the controller. Turn roaming off for a network whose clients should stay on the access point they picked.')),
		cards.length ? E('div', { 'class': 'roamd-grid' }, cards) : '',
		E('p', { 'class': 'cbi-value-description' },
			_('Every wireless network of the controller is rolled out to all nodes. A network on its own interface becomes a segment: its traffic runs to the controller separately, tagged with its own VLAN.')),
		status
	]);
}

function renderSettings(state) {
	var form = {
		backhaul_enabled: !!state.backhaul_enabled,
		backhaul_ssid: state.backhaul_ssid || '',
		backhaul_key: state.backhaul_key || '',
		wifi_shutdown: !!state.wifi_shutdown,
		node_ui: !!state.node_ui,
		backhaul_delta: state.backhaul_delta,
		backhaul_min_signal: state.backhaul_min_signal,
		auto_update: !!state.auto_update,
		auto_update_every: state.auto_update_every || 1,
		auto_update_unit: state.auto_update_unit || 'day',
		pkg_url: state.pkg_url === state.pkg_url_default ? '' : (state.pkg_url || '')
	};
	var inputs = {};
	var synced = {};

	BACKHAUL_FIELDS.forEach(function(key) { synced[key] = form[key]; });

	function toggle(key, label, desc, onchange) {
		var input = E('input', {
			'type': 'checkbox', 'checked': form[key] ? 'checked' : null,
			'disabled': readOnly || null,
			'change': function(ev) {
				form[key] = ev.target.checked;
				if (onchange)
					onchange();
			}
		});

		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				input, desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
			])
		]);
	}

	function text(key, label, desc, secret) {
		var input = E('input', {
			'type': secret ? 'password' : 'text', 'class': 'cbi-input-text',
			'value': form[key], 'disabled': readOnly || null,
			'change': function(ev) { form[key] = ev.target.value; }
		});

		inputs[key] = input;

		if (secret) {
			var reveal = E('input', {
				'type': 'checkbox',
				'change': function(ev) { input.type = ev.target.checked ? 'text' : 'password'; }
			});

			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, label),
				E('div', { 'class': 'cbi-value-field' }, [
					input, ' ', reveal, ' ', E('label', {}, _('show')),
					desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
				])
			]);
		}

		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				input, desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
			])
		]);
	}

	function number(key, label, desc, min, max) {
		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				E('input', {
					'type': 'number', 'class': 'cbi-input-text', 'style': 'width:6em',
					'min': min, 'max': max, 'value': form[key], 'disabled': readOnly || null,
					'change': function(ev) { form[key] = ev.target.value; }
				}),
				E('div', { 'class': 'cbi-value-description' }, desc)
			])
		]);
	}

	var status = E('span', { 'style': 'margin-left:1em' }, '');

	function backhaulBands(s) {
		var ssid = s.backhaul_ssid || '';
		var bands = (s.self_aps || []).filter(function(ap) { return ap.ssid === ssid; })
			.map(function(ap) { return common.bandLabel(ap.band); });

		return bands.length ? bands.join(', ') : _('not broadcasting');
	}

	function unitMax(unit) {
		for (var i = 0; i < AUTO_UNITS.length; i++)
			if (AUTO_UNITS[i].unit === unit)
				return AUTO_UNITS[i].max;

		return 1;
	}

	function clampEvery(value) {
		var max = unitMax(form.auto_update_unit);
		var n = parseInt(value, 10);

		if (isNaN(n) || n < 1)
			n = 1;

		return n > max ? max : n;
	}

	var everyInput = E('input', {
		'type': 'number', 'class': 'cbi-input-text', 'style': 'width:5em',
		'min': 1, 'max': unitMax(form.auto_update_unit),
		'value': form.auto_update_every, 'disabled': readOnly || null,
		'change': function(ev) {
			form.auto_update_every = clampEvery(ev.target.value);
			ev.target.value = form.auto_update_every;
		}
	});

	var unitSelect = E('select', {
		'class': 'cbi-input-select', 'disabled': readOnly || null,
		'change': function(ev) {
			form.auto_update_unit = ev.target.value;
			everyInput.max = unitMax(form.auto_update_unit);
			form.auto_update_every = clampEvery(everyInput.value);
			everyInput.value = form.auto_update_every;
		}
	}, AUTO_UNITS.map(function(u) {
		return E('option', {
			'value': u.unit,
			'selected': u.unit === form.auto_update_unit ? 'selected' : null
		}, u.label);
	}));

	var intervalRow = E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, _('Check for updates every')),
		E('div', { 'class': 'cbi-value-field' }, [
			everyInput, ' ', unitSelect,
			E('div', { 'class': 'cbi-value-description' },
				_('The controller checks the repository on this schedule and installs the update itself — first on the controller, then on the nodes.'))
		])
	]);

	var lastField = E('div', { 'class': 'cbi-value-field' }, lastCheckText(state));
	var lastRow = E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, _('Last check')),
		lastField
	]);

	function autoRows() {
		var display = form.auto_update ? '' : 'none';

		intervalRow.style.display = display;
		lastRow.style.display = display;
	}

	var save = E('button', {
		'class': 'btn cbi-button cbi-button-save',
		'disabled': readOnly || null,
		'click': function() {
			status.textContent = _('Saving…');
			callMeshSettings(
				form.backhaul_enabled ? '1' : '0',
				form.backhaul_ssid, form.backhaul_key,
				form.wifi_shutdown ? '1' : '0',
				form.node_ui ? '1' : '0',
				String(form.backhaul_delta), String(form.backhaul_min_signal),
				form.auto_update ? '1' : '0',
				String(form.auto_update_every), form.auto_update_unit,
				form.pkg_url
			).then(function() {
				BACKHAUL_FIELDS.forEach(function(key) { synced[key] = form[key]; });
				status.textContent = _('Saved.');
			}, function() { status.textContent = _('Save failed.'); });
		}
	}, _('Save'));

	var bandsField = E('div', { 'class': 'cbi-value-field' }, backhaulBands(state));
	var netsField = E('div', {}, renderNetworks(state));

	settingsSync = function(fresh) {
		dom.content(netsField, renderNetworks(fresh));
		dom.content(bandsField, backhaulBands(fresh));
		dom.content(lastField, lastCheckText(fresh));

		BACKHAUL_FIELDS.forEach(function(key) {
			if (inputs[key].value !== synced[key])
				return;

			inputs[key].value = form[key] = synced[key] = fresh[key] || '';
		});
	};

	var nodeUiInput = E('input', {
		'type': 'checkbox', 'checked': form.node_ui ? 'checked' : null,
		'disabled': readOnly || null,
		'change': function(ev) {
			if (!ev.target.checked) {
				form.node_ui = false;
				return;
			}

			ev.target.checked = false;

			common.showModal(_('Open the node web interface'), [
				E('p', {}, _('The web interface of every node will become reachable from the local network.')),
				E('p', {}, _('A node is not an independent router: its Wi-Fi, addresses and firewall are set by the controller and are overwritten on the next profile rollout. Settings changed on the node itself are lost, and while they are in effect the network may work incorrectly — clients stop moving between devices, or a node drops out of the system.')),
				E('p', {}, _('Open it only for diagnostics, and close it afterwards.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': function() {
							form.node_ui = true;
							nodeUiInput.checked = true;
							ui.hideModal();
						}
					}, _('Open access'))
				])
			]);
		}
	});

	var nodeUiRow = E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, _('Allow access to the node web interface')),
		E('div', { 'class': 'cbi-value-field' }, [
			nodeUiInput,
			E('div', { 'class': 'cbi-value-description' },
				_('Off by default: on a node only the controller is allowed to reach the web interface, everyone else is refused by the node firewall. When enabled, a link appears next to the node name.'))
		])
	]);

	autoRows();

	return E('div', {}, [
		netsField,

		E('h3', {}, _('Wireless backhaul')),
		E('p', { 'class': 'cbi-value-description' }, _('A hidden Wi-Fi network the nodes use to talk to each other. Leave the name and key empty to generate them automatically.')),
		toggle('backhaul_enabled', _('Wireless backhaul')),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'style': 'min-width:22em' }, _('Broadcast on bands')),
			bandsField
		]),
		number('backhaul_delta', _('5 GHz allowance'),
			_('dB. How much weaker than 2.4 GHz a 5 or 6 GHz signal may be and still be chosen.'), 0, 40),
		number('backhaul_min_signal', _('Minimum link signal'),
			_('dBm. Below this level a 5 or 6 GHz parent is not chosen while 2.4 GHz is usable.'), -95, -40),
		text('backhaul_ssid', _('Backhaul network name')),
		text('backhaul_key', _('Backhaul key'), null, true),

		E('h3', {}, _('Node behaviour')),
		nodeUiRow,
		toggle('wifi_shutdown', _('Turn off node access points when the controller is unreachable'),
			_('Nodes stop broadcasting the Wi-Fi network while the controller is not available.')),

		E('h3', {}, _('Automatic update')),
		toggle('auto_update', _('Automatic update'),
			_('roamd is updated automatically on the controller and on all nodes when a newer package is available.'),
			autoRows),
		intervalRow,
		lastRow,
		text('pkg_url', _('Package repository'),
			_('Leave empty to use the project repository. Fill it in only for your own repository: only https:// is accepted, and its certificate must be placed in /etc/roamd/pkg.crt — the delivery installs software on every node.')),

		E('div', { 'class': 'cbi-page-actions' }, [ save, status ])
	]);
}

function renderController(state) {
	var ctrl = state.controller || {};
	var counts = state.counts || {};
	var age = ctrl.last_contact || 0;
	var link = age > 60
		? E('span', { 'class': 'roamd-state roamd-state-warn' }, _('no contact for %t').format(age))
		: E('span', { 'class': 'roamd-state roamd-state-ok' }, _('in touch'));

	return E('div', {}, [
		E('p', {}, _('This node is part of the Wi-Fi system managed by the controller below. The node knows about the controller and about its own clients; the rest of the system is visible on the controller.')),
		E('div', { 'class': 'roamd-grid' }, [
			E('article', { 'class': 'roamd-card' }, [
				E('div', { 'class': 'roamd-card-head' }, [
					E('div', { 'class': 'roamd-card-id' }, [
						E('div', { 'class': 'roamd-title' }, ctrl.name || ctrl.id || _('unknown')),
						E('div', { 'class': 'roamd-pills' }, [
							E('span', { 'class': 'roamd-pill' }, _('controller'))
						])
					]),
					link
				]),
				common.facts([
					[ _('Role'), _('controller') ],
					[ _('IP address'), ctrl.addr || '—' ]
				])
			]),
			E('article', { 'class': 'roamd-card roamd-card-controller' }, [
				E('div', { 'class': 'roamd-card-head' }, [
					E('div', { 'class': 'roamd-card-id' }, [
						E('div', { 'class': 'roamd-title' }, _('This node')),
						E('div', { 'class': 'roamd-sub' }, state.member_id || '—'),
						E('div', { 'class': 'roamd-pills' }, [
							E('span', { 'class': 'roamd-pill' }, _('node'))
						])
					])
				]),
				common.facts([
					[ _('Role'), _('node') ],
					[ _('Clients'), String(counts.clients || 0) ]
				])
			])
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			meshStatusWithRoaming().catch(function() { return {}; }),
			uci.load('roamd').catch(function() { return null; })
		]);
	},

	render: function(data) {
		var state = Array.isArray(data) ? (data[0] || {}) : (data || {});

		common.ensureStyle();

		var container = E('div', { 'class': 'roamd-ui' }, [ E('h2', {}, _('Mesh Wi-Fi system')) ]);

		readOnly = common.isNode(state);
		nodeUiOpen = !!state.node_ui;

		if (readOnly)
			container.appendChild(common.controlBanner(state));

		container.appendChild(buildTabs(state));

		if (!common.isNode(state))
			poll.add(refreshNodes, 5);

		return container;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

function renderInfo() {
	function block(title, lines) {
		return E('div', { 'style': 'margin-bottom:1.5em' }, [
			E('h3', {}, title),
			E('ul', { 'style': 'margin:0 0 0 1.2em' },
				lines.map(function(t) { return E('li', { 'style': 'margin-bottom:.4em' }, t); }))
		]);
	}

	return E('div', { 'style': 'max-width:60em' }, [
		E('p', {}, _('A Wi-Fi system is several devices that behave as one network. Read this before changing anything on a node.')),

		block(_('What a node becomes after it is captured'), [
			_('A node stops being an independent router and becomes, in effect, a switch with a radio: it passes traffic through and broadcasts the Wi-Fi network, nothing more.'),
			_('The node has no router of its own any more: no address handout, no address translation, no separate Wi-Fi settings.'),
			_('The whole system has one address handout and one address translation — on the controller. Every client, wired or wireless, behind any device, gets its address from the controller and lives in one common network.')
		]),

		block(_('Where the settings live'), [
			_('All settings are made on the controller only. From there they are rolled out to every node.'),
			_('The controller rewrites the node profile on every change and on a schedule. Anything set on the node itself is overwritten on the next rollout — the change will simply disappear.'),
			_('Until it is overwritten, a setting changed on a node can break the whole network: clients stop moving between devices, a node drops out of the system, or two devices start handing out addresses at once.')
		]),

		block(_('What to do if a device needs its own settings'), [
			_('Do not capture it as a node. Leave it a separate router with its own address translation and configure it as usual.'),
			_('A device already captured can be released: on the Nodes tab choose «Remove» with a reset to factory settings. It becomes independent again.')
		]),

		block(_('Why the node web interface is closed'), [
			_('On a node the web interface is reachable only from the controller — its firewall refuses everyone else. This is deliberate: it is what stops settings from being changed in the wrong place.'),
			_('If a node has to be examined, open the access in Settings — but remember that any change made there lives only until the next rollout.')
		]),

		block(_('What is normal and needs no action'), [
			_('A node has no internet «of its own»: it works through the controller.'),
			_('A node shows no clients of the other devices — each device sees only its own; the whole picture is on the controller, on the Clients tab.'),
			_('A client that moved to another device disappears from one node and appears on another. That is roaming working, not a fault.')
		])
	]);
}

function buildTabs(state) {
	var isNode = common.isNode(state);

	nodeNames = { controller: controllerLabel(state) };
	(state.members || []).forEach(function(m) {
		nodeNames[m.id] = m.name || m.hostname || m.id;
	});

	var hash = locationHash();

	if (hash === 'clients' || hash.indexOf('clients/') === 0)
		clientFocus = hash.indexOf('clients/') === 0 ? decodeURIComponent(hash.slice(8)) : '';
	else
		clientFocus = '';

	var panes = [
		isNode
			? { key: 'controller', title: _('Controller'), node: renderController(state) }
			: { key: 'nodes', title: _('Nodes'), node: E('div', { 'id': 'mesh-nodes-pane' }, renderNodes(state)) },
		{ key: 'clients', title: _('Clients'), node: renderClients(state) },
		{ key: 'log', title: _('Transition log'), node: renderLog() },
		{ key: 'settings', title: _('Settings'), node: renderSettings(state) },
		{ key: 'info', title: _('Information'), node: renderInfo() }
	];

	var menu = E('ul', { 'class': 'cbi-tabmenu' });
	var content = E('div', { 'class': 'cbi-tabcontainer' });

	function activate(idx) {
		panes.forEach(function(p, i) {
			p.node.style.display = i === idx ? '' : 'none';
			menu.childNodes[i].className = i === idx ? 'cbi-tab' : 'cbi-tab-disabled';
		});
	}

	meshActivate = function(key) {
		var idx = 0;

		panes.forEach(function(p, i) {
			if (p.key === key)
				idx = i;
		});
		activate(idx);
	};

	panes.forEach(function(p, i) {
		menu.appendChild(E('li', {}, E('a', {
			'href': '#',
			'click': function(ev) { ev.preventDefault(); activate(i); }
		}, p.title)));
		content.appendChild(p.node);
	});

	var wrap = E('div', {}, [ menu, content ]);

	if (hash === 'clients' || hash.indexOf('clients/') === 0)
		meshActivate('clients');
	else if (hash === 'nodes')
		meshActivate('nodes');
	else
		activate(0);

	return wrap;
}
