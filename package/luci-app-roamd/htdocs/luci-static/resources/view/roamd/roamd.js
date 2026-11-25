'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require dom';
'require ui';
'require uci';
'require view.roamd.common as common';

var meshState = {};

var callStatus = rpc.declare({
	object: 'roamd',
	method: 'status',
	expect: { }
});

var statusData = {};
var hostHints = {};

function clientCell(mac) {
	return common.macCell(common.clientLabel(hostHints, common.deviceOverrides(), mac), mac);
}

function toSigned(value) {
	return common.signed(value);
}

function formatSignal(value) {
	var dbm = toSigned(value);

	return dbm ? '%d dBm'.format(dbm) : '-';
}

var PAIR_TEXT = {
	not_managed: _('not handled by the service'),
	no_peer: _('no access point of the other band with this name'),
	disabled: _('one of the access points is disabled'),
	encryption: _('encryption types differ'),
	key: _('passwords differ'),
	network: _('the access points are bridged to different networks'),
	no_11k: _('802.11k is off'),
	no_11v: _('802.11v is off'),
	fast_transition: _('802.11r is configured inconsistently'),
	no_neighbor_report: _('neighbour reports not exchanged yet')
};

var PAIR_STATE = {
	ok: { text: _('works'), color: '#2e9e2e' },
	degraded: { text: _('partly'), color: '#c98000' },
	broken: { text: _('no'), color: '#d33' }
};

function countClients() {
	var n = 0;

	eachClient(function () { n++; });

	return n;
}

function summaryStat(label, value, click) {
	var attrs = { 'class': 'roamd-stat' };

	if (click)
		attrs.click = click;

	return E(click ? 'button' : 'div', attrs, [
		E('span', { 'class': 'roamd-k' }, label),
		E('span', { 'class': 'roamd-v' }, value)
	]);
}

function openMesh(hash) {
	var path = (L && L.url) ? L.url('admin/network/roamd_mesh') : '';

	window.location.href = path + '#' + hash;
}

function renderSummary() {
	var role = statusData.mesh_role || meshState.role;
	var pref = statusData.prefer_band;
	var prefText = (pref === '2' || pref === '2.4') ? _('2.4 GHz')
		: (pref === '5' ? _('5 GHz')
		: (pref === '6' ? _('6 GHz') : _('No preference')));
	var stats = [];

	if (role)
		stats.push(summaryStat(_('Role'), role === 'node' ? _('node') : _('controller')));

	stats.push(summaryStat(_('Roaming'), statusData.enabled ? _('yes') : _('no')));

	if (statusData.band_steering)
		stats.push(summaryStat(_('Preferred band'), prefText));

	stats.push(summaryStat(_('Clients'), String(countClients()), function() { openMesh('clients'); }));

	if (meshState.counts && meshState.counts.nodes != null && role !== 'node')
		stats.push(summaryStat(_('Nodes'), String(meshState.counts.nodes), function() { openMesh('nodes'); }));

	return E('div', { 'class': 'roamd-summary' }, stats);
}

function clientBlock(mac, client, iface) {
	var bands = client.bands || {};
	var names = [];
	var label = common.clientLabel(hostHints, common.deviceOverrides(), mac);
	var extra = E('div', { 'class': 'roamd-row-extra', 'style': 'display:none' });
	var lines = [
		'802.11v %s'.format(client.btm ? _('yes') : _('no')),
		'802.11k %s'.format(client.rrm ? _('yes') : _('no')),
		'%s %d'.format(_('Steering attempts'), client.steer_count || 0)
	];

	for (var b in bands)
		if (bands[b].seen)
			names.push(b);

	names.sort(function(a, c) {
		return common.bandKind(a) < common.bandKind(c) ? -1 : 1;
	});

	names.forEach(function(b) {
		var serving = common.bandKind(b) === common.bandKind(iface.band);

		lines.push(E('div', {}, [
			common.bandLabel(b) + ' ',
			common.dbmText(bands[b].signal, { serving: serving })
		]));
	});

	dom.content(extra, lines);

	return E('div', {}, [
		E('div', { 'class': 'roamd-row' }, [
			E('div', { 'class': 'roamd-row-main' },
				common.macCell(label, mac)),
			E('span', {}, common.bandLabel(iface.band)),
			common.dbmText(client.signal, { serving: true }),
			E('span', { 'class': 'roamd-muted' }, '%t'.format(client.connected || 0))
		].concat(E('button', {
			'class': 'btn cbi-button',
			'click': function() {
				extra.style.display = extra.style.display ? '' : 'none';
			}
		}, _('Details')))),
		extra
	]);
}

function ifaceCard(name, iface) {
	var info = iface.roaming || {};
	var state = PAIR_STATE[info.state] || PAIR_STATE.broken;
	var issues = info.issues || [];
	var clients = [];
	var cmap = iface.clients || {};
	var kind = info.state === 'ok' ? 'ok' : (info.state === 'degraded' ? 'warn' : 'bad');
	var roam = [
		E('span', { 'class': 'roamd-state roamd-state-' + kind }, state.text)
	];

	if (info.peer && !issues.length)
		roam.push(E('div', { 'class': 'roamd-muted' }, _('paired with %s').format(info.peer)));

	issues.forEach(function (code) {
		roam.push(E('div', { 'class': 'roamd-muted' }, PAIR_TEXT[code] || code));
	});

	for (var mac in cmap)
		clients.push(clientBlock(mac, cmap[mac], iface));

	return E('article', { 'class': 'roamd-card' + (iface.active ? '' : ' roamd-card-off') }, [
		E('div', { 'class': 'roamd-card-head' }, [
			E('div', { 'class': 'roamd-card-id' }, [
				E('div', { 'class': 'roamd-title' }, iface.band
					? '%s · %s %s'.format(common.bandLabel(iface.band), _('Channel'), iface.channel || '—')
					: (iface.ssid || name)),
				E('div', { 'class': 'roamd-sub' }, iface.ssid ? '%s · %s'.format(iface.ssid, name) : name)
			]),
			E('span', {
				'class': iface.active ? 'roamd-state roamd-state-ok' : 'roamd-state roamd-state-off'
			}, iface.active ? _('running') : _('down'))
		]),
		E('div', { 'class': 'roamd-roam' }, [
			E('div', { 'class': 'roamd-k' }, _('Roaming')),
			E('div', {}, roam)
		]),
		clients.length
			? E('div', {}, clients)
			: E('div', { 'class': 'roamd-muted' }, _('No connected clients'))
	]);
}

function renderBoard() {
	var ifaces = statusData.interfaces || {};
	var names = [];

	for (var name in ifaces)
		names.push(name);

	return E('div', {}, [
		renderSummary(),
		E('h3', {}, _('Wireless interfaces')),
		names.length
			? E('div', { 'class': 'roamd-grid' }, names.map(function (name) {
				return ifaceCard(name, ifaces[name]);
			}))
			: E('div', { 'class': 'roamd-empty' }, E('em', {}, _('No wireless interfaces found')))
	]);
}

function eachClient(callback) {
	var ifaces = statusData.interfaces || {};

	for (var name in ifaces) {
		var clients = ifaces[name].clients || {};

		for (var mac in clients)
			callback(mac, clients[mac], name, ifaces[name]);
	}
}


var WIZARD_NETWORK = 'lan';
var DEFAULT_SSID = 'OpenWrt';

function deviceBand(section) {
	if (section.band)
		return section.band;

	var hwmode = section.hwmode || '';

	if (hwmode.indexOf('a') >= 0)
		return '5g';

	if (hwmode)
		return '2g';

	if (section.channel && parseInt(section.channel) > 14)
		return '5g';

	return section.channel ? '2g' : null;
}

function bandGroup(band) {
	if (band === '2g' || band === '2.4' || band === '2')
		return 'low';

	/* 6 GHz is its own band. It is not a 5 GHz radio. */
	if (band === '6g' || band === '6')
		return 'six';

	return 'high';
}

function bandTitle(band) {
	if (band === '2g')
		return _('2.4 GHz');
	if (band === '6g')
		return _('6 GHz');

	return _('5 GHz');
}

function defaultNetwork() {
	var ifaces = uci.sections('wireless', 'wifi-iface');

	for (var i = 0; i < ifaces.length; i++) {
		if (ifaces[i].mode === 'ap' && ifaces[i].network)
			return ifaces[i].network;
	}

	return WIZARD_NETWORK;
}

function wizardProbe() {
	var devices = uci.sections('wireless', 'wifi-device');
	var radios = [];
	var groups = {};

	if (!L.hasSystemFeature('hostapd'))
		return { ok: false, reason: 'no_hostapd' };

	for (var i = 0; i < devices.length; i++) {
		var band = deviceBand(devices[i]);

		if (!band)
			continue;

		radios.push({
			name: devices[i]['.name'],
			band: band,
			group: bandGroup(band),
			disabled: (devices[i].disabled == '1')
		});

		groups[bandGroup(band)] = true;
	}

	if (!radios.length)
		return { ok: false, reason: 'no_radio' };

	var bands = 0;

	for (var group in groups)
		if (groups[group])
			bands++;

	/* 2.4, 5 and 6 GHz each count. Two 5 GHz radios are still one band. */
	if (bands < 2)
		return { ok: false, reason: 'single_band', radios: radios };

	return {
		ok: true,
		radios: radios,
		network: defaultNetwork(),
		ft: !!L.hasSystemFeature('hostapd', '11r'),
		sae: !!L.hasSystemFeature('hostapd', 'sae')
	};
}

function probeMessage(reason) {
	if (reason === 'no_hostapd')
		return _('This system has no hostapd with ubus support, so a roaming network cannot be created.');

	if (reason === 'no_radio')
		return _('No wireless radios were found on this device.');

		return _('This device has radios of one band only. Roaming needs radios on at least two different bands (2.4, 5 or 6 GHz).');
}

function buildPlan(probe, ssid) {
	var ifaces = uci.sections('wireless', 'wifi-iface');
	var byDevice = {};
	var plan = [];

	for (var i = 0; i < ifaces.length; i++) {
		var iface = ifaces[i];

		if (iface.mode !== 'ap' || !iface.device)
			continue;

		var reuse = (iface.ssid === ssid) ? 2 :
			(iface.ssid === DEFAULT_SSID && (!iface.encryption || iface.encryption === 'none')) ? 1 : 0;

		if (reuse && (!byDevice[iface.device] || byDevice[iface.device].rank < reuse))
			byDevice[iface.device] = { sid: iface['.name'], rank: reuse };
	}

	probe.radios.forEach(function (radio) {
		var match = byDevice[radio.name];

		plan.push({
			radio: radio,
			sid: match ? match.sid : null,
			reused: !!match
		});
	});

	return plan;
}

function planWarnings(plan) {
	var warnings = [];
	var enabling = plan.filter(function (p) { return p.radio.disabled; });

	if (enabling.length)
		warnings.push(_('The following radios are currently disabled and will be switched on: %s.')
			.format(enabling.map(function (p) { return p.radio.name; }).join(', ')));

	return warnings;
}

function validate(ssid, key) {
	var bytes = unescape(encodeURIComponent(ssid)).length;

	if (bytes < 1 || bytes > 32)
		return _('The network name must be between 1 and 32 bytes long.');

	if (key.length < 8 || key.length > 63)
		return _('The password must be between 8 and 63 characters long.');

	return null;
}

function applyWizard(probe, ssid, encryption, key) {
	var plan = buildPlan(probe, ssid);
	var network = probe.network;

	plan.forEach(function (entry) {
		var sid = entry.sid || uci.add('wireless', 'wifi-iface');

		uci.set('wireless', sid, 'device', entry.radio.name);
		uci.set('wireless', sid, 'mode', 'ap');
		uci.set('wireless', sid, 'network', network);
		uci.set('wireless', sid, 'ssid', ssid);
		uci.set('wireless', sid, 'encryption', encryption);
		uci.set('wireless', sid, 'key', key);
		uci.unset('wireless', sid, 'disabled');
		uci.unset('wireless', entry.radio.name, 'disabled');
	});

	uci.set('roamd', 'global', 'enabled', '1');

	return uci.save().then(function () {
		return ui.changes.apply(true);
	});
}

function showUnsupported(probe) {
	ui.showModal(_('Roaming network wizard'), [
		E('p', { 'class': 'alert-message warning' }, probeMessage(probe.reason)),
		E('p', {}, _('Nothing has been changed.')),
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn cbi-button',
				'click': ui.hideModal
			}, _('Close'))
		])
	]);
}

function showWizard(probe) {
	var ssidInput = E('input', {
		'type': 'text',
		'class': 'cbi-input-text',
		'maxlength': '32',
		'placeholder': _('for example, Home')
	});

	var keyInput = E('input', {
		'type': 'password',
		'class': 'cbi-input-password',
		'placeholder': _('at least 8 characters')
	});

	var encSelect = E('select', { 'class': 'cbi-input-select' }, [
		E('option', { 'value': 'psk2' }, _('WPA2 (compatible with everything)'))
	]);

	if (probe.sae) {
		encSelect.appendChild(E('option', { 'value': 'sae-mixed' }, _('WPA2/WPA3 (recommended)')));
		encSelect.appendChild(E('option', { 'value': 'sae' }, _('WPA3 only (modern devices)')));
	}

	var errorBox = E('p', { 'class': 'alert-message warning', 'style': 'display:none' });

	var summary = probe.radios.map(function (radio) {
		return E('li', {}, '%s — %s%s'.format(radio.name, bandTitle(radio.band),
			radio.disabled ? ' (%s)'.format(_('currently disabled')) : ''));
	});

	var notes = [];

	if (!probe.ft)
		notes.push(E('p', { 'class': 'alert-message warning' },
			_('This hostapd build has no 802.11r support. Roaming will work through 802.11k and 802.11v, but transitions will be slower.')));

	planWarnings(buildPlan(probe, '')).forEach(function (text) {
		notes.push(E('p', { 'class': 'alert-message warning' }, text));
	});

	function field(title, widget, help) {
		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, title),
			E('div', { 'class': 'cbi-value-field' }, [
				widget,
				help ? E('div', { 'class': 'cbi-value-description' }, help) : ''
			])
		]);
	}

	function submit() {
		var ssid = ssidInput.value.trim();
		var key = keyInput.value;
		var encryption = encSelect.value;
		var check = wizardProbe();

		if (!check.ok) {
			ui.hideModal();
			showUnsupported(check);
			return;
		}

		var error = validate(ssid, key);

		if (error) {
			errorBox.textContent = error;
			errorBox.style.display = '';
			return;
		}

		ui.showModal(_('Roaming network wizard'), [
			E('p', { 'class': 'spinning' }, _('Creating the network…'))
		]);

		applyWizard(check, ssid, encryption, key).catch(function (err) {
			ui.showModal(_('Roaming network wizard'), [
				E('p', { 'class': 'alert-message danger' }, '%h'.format(err)),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close'))
				])
			]);
		});
	}

	ui.showModal(_('Roaming network wizard'), [
		E('p', {}, _('Creates one network on every band with the same name and password, and turns roaming on. Channel, width and other details can be adjusted later under Network → Wireless.')),
		E('p', {}, _('Radios that will be used:')),
		E('ul', {}, summary),
		E([], notes),
		E('div', {}, [
			field(_('Network name (SSID)'), ssidInput),
			field(_('Encryption'), encSelect, _('Only the modes that support fast roaming are offered.')),
			field(_('Password'), keyInput)
		]),
		errorBox,
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': submit }, _('Create network'))
		])
	]);
}

function renderWizardButton() {
	return E('div', { 'style': 'margin: 1em 0' }, [
		E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'click': function () {
				uci.load([ 'wireless', 'roamd' ]).then(function () {
					var probe = wizardProbe();

					if (probe.ok)
						showWizard(probe);
					else
						showUnsupported(probe);
				});
			}
		}, _('Create a roaming network…')),
		E('div', { 'class': 'cbi-value-description' },
			_('Quick setup: one name and password for both bands, roaming enabled automatically.'))
	]);
}

function renderStatus() {
	return E('div', {}, [
		E('div', { 'id': 'roamd-ifaces' }, renderBoard()),
		common.isNode(meshState) ? '' : renderWizardButton()
	]);
}

var StatusTab = form.DummyValue.extend({
	render: function () {
		return E('div', { 'class': 'cbi-section' }, [
			E('div', { 'id': 'roamd-status' }, renderStatus())
		]);
	},
	load: function () { return null; },
	parse: function () { return Promise.resolve(); },
	cfgvalue: function () { return null; },
	formvalue: function () { return null; },
	write: function () {},
	remove: function () {}
});

function toggleActions(ev) {
	document.querySelector('#view > .cbi-page-actions').style.display =
		ev.detail.tab === 'status' ? 'none' : '';
}

return view.extend({
	load: function () {
		return Promise.all([
			callStatus().catch(function () { return {}; }),
			common.hostHints(),
			common.meshStatus().catch(function () { return {}; })
		]);
	},

	render: function (data) {
		var m, s, sub, o;

		common.ensureStyle();
		statusData = data[0] || {};
		hostHints = data[1] || {};
		meshState = data[2] || {};

		poll.add(function () {
			return callStatus().then(function (res) {
				var board = document.getElementById('roamd-ifaces');

				statusData = res || {};

				if (board)
					dom.content(board, renderBoard());
			});
		}, 5);

		m = new form.Map('roamd', _('Wi-Fi Roaming'),
			_('Seamless roaming between the 2.4 GHz and 5 GHz networks of this router. Both bands must use the same SSID and the same password.'));

		m.readonly = common.isNode(meshState);

		s = m.section(form.NamedSection, 'global', 'roamd');
		s.addremove = false;

		s.tab('status', _('Roaming status'));
		s.tab('general', _('General'));
		s.tab('policy', _('Switching parameters'));

		s.taboption('status', StatusTab, '_status');

		o = s.taboption('general', form.Flag, 'enabled', _('Enable roaming'),
			_('Start the roaming daemon.'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'band_steering', _('Band steering'),
			_('Move dual-band clients to the preferred band when its signal is good enough.'));
		o.default = '1';

		o = s.taboption('general', form.ListValue, 'prefer_band', _('Preferred band'));
		o.value('5', _('5 GHz'));
		o.value('6', _('6 GHz'));
		o.value('2', _('2.4 GHz'));
		o.value('none', _('No preference'));
		o.default = '5';
		o.depends('band_steering', '1');

		o = s.taboption('general', form.Flag, 'fast_transition', _('Fast roaming (802.11r)'),
			_('Fast transition between the bands without a full reauthentication. Requires WPA2/WPA3 with a pre-shared key. Very old clients may fail to connect.'));
		o.default = '1';

		o = s.taboption('general', form.Flag, 'ft_over_ds', _('802.11r over the distribution system'),
			_('Perform the fast transition over the wired side instead of over the air.'));
		o.default = '1';
		o.depends('fast_transition', '1');

		o = s.taboption('general', form.Value, 'mobility_domain', _('Mobility domain'),
			_('Four hexadecimal digits shared by all access points of one roaming domain. Leave empty to derive it from the SSID.'));
		o.datatype = 'and(hexstring,length(4))';
		o.placeholder = _('automatic');
		o.depends('fast_transition', '1');

		o = s.taboption('general', form.Flag, 'neighbor_reports', _('Neighbour reports (802.11k)'),
			_('Tell clients about the other band so they can find it without a full scan.'));
		o.default = '1';

		o = s.taboption('general', form.Flag, 'bss_transition', _('Assisted roaming (802.11v)'),
			_('Ask connected clients to move to the other band.'));
		o.default = '1';

		o = s.taboption('general', form.Flag, 'apply_wireless', _('Configure wireless automatically'),
			_('Write the 802.11k/v/r options into the wireless configuration. Turn this off to manage them by hand.'));
		o.default = '1';

		o = s.taboption('policy', form.SectionValue, '_policy', form.NamedSection, 'policy', 'policy',
			null, _('The defaults suit most homes. Change them only if the behaviour does not suit you.'));
		sub = o.subsection;
		sub.addremove = false;

		o = sub.option(form.Value, 'rssi_good', _('Good signal'),
			_('Above this level the preferred band is considered usable and the client is steered to it.'));
		o.datatype = 'range(-100,-1)';
		o.default = '-55';

		o = sub.option(form.Value, 'rssi_low', _('Weak signal'),
			_('Below this level the preferred band is not offered to the client.'));
		o.datatype = 'range(-100,-1)';
		o.default = '-75';

		o = sub.option(form.Value, 'rssi_diff', _('Band difference'),
			_('Keep the client where it is when the current band is this many dB stronger.'));
		o.datatype = 'range(1,60)';
		o.default = '30';

		o = sub.option(form.Value, 'node_rssi_diff', _('Device difference'),
			_('Move the client to another device of the Wi-Fi system when that device hears it this many dB better on the same band.'));
		o.datatype = 'range(1,60)';
		o.default = '12';

		o = sub.option(form.Value, 'kick_rssi', _('Disconnect threshold'),
			_('A client below this level is moved away even from the preferred band.'));
		o.datatype = 'range(-100,-1)';
		o.default = '-82';

		o = sub.option(form.Flag, 'deny_probe', _('Hide the non-preferred band'),
			_('Do not answer probe and authentication requests on the non-preferred band while the preferred one is good.'));
		o.default = '1';

		o = sub.option(form.Flag, 'allow_kick', _('Force disconnect'),
			_('Disconnect clients without 802.11v support when they have to be moved: they cannot be asked to roam, and until this is enabled such a client stays on a dying link until it decides to leave on its own, which can take minutes. Some clients reconnect to the same band.'));
		o.default = '0';

		o = sub.option(form.Value, 'hold_time', _('Hold time'),
			_('Milliseconds after connecting before the client may be steered.'));
		o.datatype = 'uinteger';
		o.default = '30000';

		o = sub.option(form.Value, 'steer_retries', _('Steering attempts'),
			_('Roaming requests per connection, 5 seconds apart. A client that stays after the last one is left alone until it reconnects.'));
		o.datatype = 'range(1,10)';
		o.default = '3';

		o = sub.option(form.Value, 'deny_time', _('Block duration'),
			_('Milliseconds the non-preferred band stays hidden from one client.'));
		o.datatype = 'uinteger';
		o.default = '15000';

		o = sub.option(form.Value, 'check_time_high', _('5 GHz observation window'),
			_('Milliseconds a 5 GHz measurement stays valid for the connection decision.'));
		o.datatype = 'uinteger';
		o.default = '4000';

		o = sub.option(form.Value, 'check_time_low', _('2.4 GHz observation window'),
			_('Milliseconds a 2.4 GHz measurement stays valid for the connection decision.'));
		o.datatype = 'uinteger';
		o.default = '8000';

		o = sub.option(form.Value, 'age_time', _('Client record lifetime'),
			_('Milliseconds an inactive client is remembered.'));
		o.datatype = 'uinteger';
		o.default = '90000';

		o = sub.option(form.Value, 'poll_interval', _('Poll interval'),
			_('Milliseconds between signal measurements.'));
		o.datatype = 'uinteger';
		o.default = '2000';

		o = sub.option(form.Value, 'beacon_req_interval', _('Beacon request interval'),
			_('Milliseconds between 802.11k measurements of the other band.'));
		o.datatype = 'uinteger';
		o.default = '20000';

		o = sub.option(form.Value, 'bandwidth_threshold', _('Receive rate limit'),
			_('Do not steer a client while it is receiving faster than this many Mbit/s. The figure is traffic measured from byte counters, not the PHY rate. 0 turns the check off.'));
		o.datatype = 'uinteger';
		o.default = '6';

		o = sub.option(form.Flag, 'use_station_count', _('Prefer the less crowded access point'),
			_('When the signal is a tie, choose the access point with fewer connected clients.'));
		o.default = '0';

		o = sub.option(form.Value, 'max_station_diff', _('Client-count difference'),
			_('The other access point wins that tie only when it has more than this many fewer clients. Two candidate access points are compared by their full counts. The client is subtracted only from the access point it is associated with.'));
		o.datatype = 'range(1,100)';
		o.default = '1';
		o.depends('use_station_count', '1');

		o = sub.option(form.Value, 'load_balancing_threshold', _('Load-balance difference'),
			_('Ask a client to move when another access point has at least this many fewer clients and the signal there is not worse. 0 turns this off.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = sub.option(form.Value, 'chan_util_val', _('Quiet channel'),
			_('Channel utilization at or below this (0–255, as hostapd reports it) counts as a quiet channel when the signal is a tie.'));
		o.datatype = 'range(0,255)';
		o.default = '140';

		o = sub.option(form.Value, 'max_chan_util_val', _('Busy channel'),
			_('Channel utilization above this (0–255) makes an access point a worse target. A small signal gain does not move a client there, and a client on a channel this busy may be asked to move to a quieter one.'));
		o.datatype = 'range(0,255)';
		o.default = '170';

		o = sub.option(form.Value, 'chan_util_avg_period', _('Utilization average'),
			_('How many hostapd samples to average before the channel-utilization figure is updated. The figure stays unknown until that many samples exist.'));
		o.datatype = 'range(1,60)';
		o.default = '3';

		o = sub.option(form.Value, 'load_kick_threshold', _('Channel load limit'),
			_('Also treat a channel as busy when its utilization is above this percent and it has at least the minimum number of clients. The client is asked to move, not disconnected. 0 turns this off.'));
		o.datatype = 'range(0,100)';
		o.default = '0';

		o = sub.option(form.Value, 'load_kick_min_clients', _('Clients before load matters'),
			_('The channel-load percent is ignored until the access point has at least this many clients.'));
		o.datatype = 'uinteger';
		o.default = '10';

		o = sub.option(form.Value, 'initial_connect_delay', _('Probe response delay'),
			_('Milliseconds to wait before answering probes from a client that has just been heard, so neighbouring access points hear it too. A later attempt starts the wait again. Authentication and association are not delayed. 0 answers at once.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = sub.option(form.ListValue, 'log_level', _('Log level'));
		o.value('0', _('Errors only'));
		o.value('1', _('Normal'));
		o.value('2', _('Debug'));
		o.default = '1';

		this.handleSave = null;
		this.handleSaveApply = function (ev, mode) {
			return m.save().then(function () {
				return ui.changes.apply(mode == '0');
			});
		};

		if (!common.isNode(meshState))
			return m.render().then(function (node) {
				node.addEventListener('cbi-tab-active', toggleActions, true);
				return node;
			});

		this.handleSaveApply = null;
		this.handleReset = null;

		return m.render().then(function (form) {
			return E('div', {}, [ common.controlBanner(meshState), form ]);
		});
	}
});
