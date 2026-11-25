#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "roamd.h"
#include "mesh.h"

#define BTM_VALIDITY_PERIOD	100
#define BTM_MBO_REASON		5
#define BTM_CELL_PREF		0
#define KICK_REASON		5
#define STEER_RETRY_INTERVAL	5000
#define BEACON_REQ_PER_POLL	4
#define MESH_MEASURE_INTERVAL	5000
#define BEACON_REQ_GAP		2000
#define MESH_MEASURE_CHANNELS	8

static struct blob_buf b;

static enum roam_band preferred_band(void)
{
	return config.prefer == PREFER_LOW ? BAND_LOW : BAND_HIGH;
}

static const char *bss_nr_string(const struct roam_bss *bss)
{
	static const struct blobmsg_policy policy[3] = {
		{ .type = BLOBMSG_TYPE_STRING },
		{ .type = BLOBMSG_TYPE_STRING },
		{ .type = BLOBMSG_TYPE_STRING },
	};
	struct blob_attr *tb[3];

	if (!bss->nr)
		return NULL;

	blobmsg_parse_array(policy, 3, tb, blobmsg_data(bss->nr), blobmsg_data_len(bss->nr));
	if (!tb[2])
		return NULL;

	return blobmsg_get_string(tb[2]);
}

static bool band_info_fresh(const struct roam_sta_band *info, enum roam_band band)
{
	if (!info->present || info->signal == ROAMD_NO_SIGNAL)
		return false;

	return roam_now - info->seen <= config.age_time;
}

bool roam_policy_allow(struct roam_sta *sta, struct roam_bss *bss, enum roam_event ev)
{
	struct roam_sta_band *pref, *cur;
	enum roam_band want;

	if (!config.enabled || !roam_bss_matches(bss))
		return true;

	if (roam_admit(sta->addr, mesh_self_node_id(), bss->band) != ADMIT_OK)
		return false;

	if (ev == EVENT_ASSOC || !roam_bss_target(bss))
		return true;

	if (!config.band_steering || config.prefer == PREFER_NONE || !config.deny_probe)
		return true;

	want = preferred_band();
	if (bss->band == want)
		return true;

	pref = &sta->band[want];
	cur = &sta->band[bss->band];

	if (roam_now < cur->allow_until)
		return true;

	if (!pref->present || roam_now - pref->seen > config.check_time[want])
		goto allow;

	if (pref->signal == ROAMD_NO_SIGNAL || pref->signal < config.rssi_low)
		goto allow;

	if (pref->signal < config.rssi_good)
		goto allow;

	if (cur->signal != ROAMD_NO_SIGNAL && cur->signal - pref->signal >= config.rssi_diff)
		goto allow;

	if (!cur->deny_start)
		cur->deny_start = roam_now;

	if (roam_now - cur->deny_start < config.deny_time)
		return false;

	cur->deny_start = 0;
	cur->allow_until = roam_now + config.age_time;

	roam_log(ROAM_L_INFO, "roamd: %s insists on %s GHz, giving up",
		 sta->mac, roam_band_name(bss->band));

	return true;

allow:
	cur->deny_start = 0;
	return true;
}

/* a client that ignored steer_retries requests stays quiet until it reconnects */
static bool beacon_req_silenced(const struct roam_sta *sta)
{
	return sta->beacon_req_silent >= config.steer_retries;
}

static void beacon_req_send(struct roam_sta *sta, struct roam_bss *from, const char *ssid,
			    int op_class, int channel)
{
	sta->beacon_req_silent++;

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "addr", sta->mac);
	blobmsg_add_string(&b, "ssid", ssid);
	blobmsg_add_u32(&b, "mode", 1);
	blobmsg_add_u32(&b, "duration", 50);
	blobmsg_add_u32(&b, "channel", channel);
	blobmsg_add_u32(&b, "op_class", op_class);
	roam_bss_invoke(from, "rrm_beacon_req", &b);
}

static void policy_beacon_request(struct roam_sta *sta, struct roam_bss *from, struct roam_bss *to,
				  unsigned int *budget)
{
	if (!sta->rrm || !config.neighbor_reports || !to->op_class)
		return;

	if (beacon_req_silenced(sta))
		return;

	if (roam_now - sta->last_beacon_req < config.beacon_req_interval ||
	    roam_now - sta->last_mesh_req < BEACON_REQ_GAP)
		return;

	if (!*budget)
		return;

	(*budget)--;

	sta->last_beacon_req = roam_now;
	beacon_req_send(sta, from, to->ssid, to->op_class, to->channel);
}

/*
 * Measure this network on the other devices of the system. A connected phone
 * rarely probes, so without this the controller hardly ever hears it elsewhere.
 * The client's own channel is in the rotation too: the controller compares the
 * client's view of both BSSes, not the client's view against the AP's.
 */
static void policy_mesh_measure(struct roam_sta *sta, struct roam_bss *bss, unsigned int *budget)
{
	struct mesh_channel ch[MESH_MEASURE_CHANNELS] = {
		{ .op_class = bss->op_class, .channel = bss->channel }
	};
	int here = sta->band[bss->band].signal;
	unsigned int n;

	if (!sta->rrm || !config.neighbor_reports || !bss->op_class || !*budget)
		return;

	/* a strong link is not worth the phone's airtime and battery */
	if (here == ROAMD_NO_SIGNAL || here >= config.rssi_good)
		return;

	if (roam_now - sta->last_mesh_req < MESH_MEASURE_INTERVAL ||
	    roam_now - sta->last_beacon_req < BEACON_REQ_GAP)
		return;

	if (beacon_req_silenced(sta))
		return;

	n = mesh_neighbor_channels(bss->ssid, bss->band, ch, 1, ARRAY_SIZE(ch));
	if (n < 2)
		return;

	(*budget)--;

	sta->last_mesh_req = roam_now;
	n = sta->mesh_req_idx++ % n;
	beacon_req_send(sta, bss, bss->ssid, ch[n].op_class, ch[n].channel);
}

static void policy_btm(struct roam_sta *sta, struct roam_bss *from, struct roam_bss *to)
{
	const char *nr = bss_nr_string(to);
	void *list;

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "addr", sta->mac);
	blobmsg_add_u32(&b, "dialog_token", ++sta->dialog_token);
	blobmsg_add_u8(&b, "disassociation_imminent", 0);
	blobmsg_add_u32(&b, "disassociation_timer", 0);
	blobmsg_add_u32(&b, "reassoc_delay", 0);

	blobmsg_add_u8(&b, "abridged", 1);
	blobmsg_add_u32(&b, "validity_period", BTM_VALIDITY_PERIOD);
	blobmsg_add_u32(&b, "mbo_reason", BTM_MBO_REASON);
	blobmsg_add_u32(&b, "cell_pref", BTM_CELL_PREF);

	list = blobmsg_open_array(&b, "neighbors");
	if (nr)
		blobmsg_add_string(&b, NULL, nr);
	blobmsg_close_array(&b, list);

	roam_bss_invoke(from, "bss_transition_request", &b);

	sta->last_steer = roam_now;
	sta->steer_from = from->band;
	sta->steer_count++;

	mesh_log_local(sta->mac, from->band, to->band, NULL, MESH_EV_STEER);

	roam_log(ROAM_L_INFO, "roamd: steering %s from %s GHz to %s GHz (attempt %u of %u)",
		 sta->mac, roam_band_name(from->band), roam_band_name(to->band),
		 sta->steer_count, config.steer_retries);
}

static void sta_del_client(struct roam_sta *sta, struct roam_bss *from)
{
	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "addr", sta->mac);
	blobmsg_add_u32(&b, "reason", KICK_REASON);
	blobmsg_add_u8(&b, "deauth", 1);
	blobmsg_add_u32(&b, "ban_time", config.deny_time);
	roam_bss_invoke(from, "del_client", &b);

	roam_sta_reset(sta);
}

static void policy_evict(struct roam_sta *sta, struct roam_bss *from, enum roam_admit verdict)
{
	bool node = verdict == ADMIT_DENY_NODE;

	roam_log(ROAM_L_INFO, "roamd: %s is not allowed %s, disconnecting from %s (%s GHz)",
		 sta->mac, node ? "on this device" : "on this band",
		 from->ifname, roam_band_name(from->band));

	mesh_log_local(sta->mac, from->band, MESH_BAND_NA, NULL,
		       node ? MESH_EV_DENY_NODE : MESH_EV_DENY_BAND);

	sta_del_client(sta, from);
}

void roam_policy_kick(struct roam_sta *sta, struct roam_bss *from)
{
	roam_log(ROAM_L_INFO, "roamd: disconnecting %s from %s (%s GHz)",
		 sta->mac, from->ifname, roam_band_name(from->band));

	sta->last_steer = roam_now;
	sta->steer_from = from->band;
	sta->steer_count++;

	mesh_log_local(sta->mac, from->band, MESH_BAND_NA, NULL, MESH_EV_KICK);
	sta_del_client(sta, from);
}

bool roam_policy_can_steer(const struct roam_sta *sta)
{
	if (sta->steer_count >= config.steer_retries)
		return false;

	return !sta->last_steer || roam_now - sta->last_steer >= STEER_RETRY_INTERVAL;
}

/* hostapd reports the last receive bitrate in kbit/s. Dawn treats a rate above
 * bandwidth_threshold (Mbit/s) as an active transfer and leaves the client. */
bool roam_policy_rate_busy(uint32_t rx_kbit, bool known)
{
	uint32_t limit;

	if (!known || config.bandwidth_threshold <= 0)
		return false;

	if (config.bandwidth_threshold > 4000000)
		return false;

	limit = (uint32_t)config.bandwidth_threshold * 1000;

	return rx_kbit > limit;
}

/* Hold the probe response until neighbouring APs have also heard the client.
 * Auth and assoc are not held: this is not a rejection. */
bool roam_policy_delay_probe(const struct roam_sta *sta)
{
	if (!config.initial_connect_delay || !sta || sta->bss || !sta->created)
		return false;

	return roam_now - sta->created < config.initial_connect_delay;
}

bool roam_air_busy(const struct roam_air *air)
{
	bool util_busy = false;

	if (!air)
		return false;

	if (air->util >= 0 && config.max_chan_util_val > 0 &&
	    air->util > config.max_chan_util_val)
		util_busy = true;

	if (config.load_kick_threshold && air->util >= 0 && air->stations >= 0 &&
	    air->stations >= (int)config.load_kick_min_clients &&
	    air->util * 100 / 255 > (int)config.load_kick_threshold)
		util_busy = true;

	return util_busy;
}

/* 1 quiet, 0 ordinary or unknown, -1 busy. Quiet only breaks a tie. */
int roam_air_rank(const struct roam_air *air)
{
	if (roam_air_busy(air))
		return -1;

	if (air && air->util >= 0 && config.chan_util_val > 0 &&
	    air->util <= config.chan_util_val)
		return 1;

	return 0;
}

/* Dawn: the other AP wins a tie when it has more than max_station_diff fewer
 * clients. The client itself is not counted on the AP it is already on. */
bool roam_air_fewer_stations(const struct roam_air *cur, const struct roam_air *neu)
{
	int own, other;

	if (!config.use_station_count || !cur || !neu)
		return false;

	if (cur->stations < 0 || neu->stations < 0)
		return false;

	own = cur->stations > 0 ? cur->stations - 1 : 0;
	other = neu->stations;

	return own - other > config.max_station_diff;
}

/* usteer: n_new + load_balancing_threshold <= n_cur. 0 disables it. */
bool roam_air_lighter(const struct roam_air *cur, const struct roam_air *neu)
{
	if (!config.load_balancing_threshold || !cur || !neu)
		return false;

	if (cur->stations < 0 || neu->stations < 0)
		return false;

	return neu->stations + (int)config.load_balancing_threshold <= cur->stations;
}

static bool sta_should_leave(struct roam_sta *sta, struct roam_bss *bss,
			     struct roam_bss *target)
{
	enum roam_band want = preferred_band();
	int here = sta->band[bss->band].signal;
	int there;

	if (here != ROAMD_NO_SIGNAL && here < config.kick_rssi)
		return true;

	if (!band_info_fresh(&sta->band[target->band], target->band))
		return false;

	there = sta->band[target->band].signal;

	if (here != ROAMD_NO_SIGNAL && there - here >= config.rssi_diff)
		return true;

	if (bss->band == want) {
		if (here == ROAMD_NO_SIGNAL || here >= config.rssi_low)
			return false;

		return there > here;
	}

	if (want == BAND_HIGH && bss->band == BAND_LOW && !sta->band[bss->band].ht)
		return false;

	if (there < config.rssi_good)
		return false;

	return here == ROAMD_NO_SIGNAL || here - there < config.rssi_diff;
}

void roam_policy_run(struct roam_bss *bss)
{
	unsigned int beacon_budget = BEACON_REQ_PER_POLL;
	struct roam_bss *target;
	struct roam_sta *sta;

	if (!config.enabled)
		return;

	avl_for_each_element(&roam_sta_tree, sta, avl) {
		enum roam_admit verdict;

		if (sta->bss != bss)
			continue;

		verdict = roam_admit(sta->addr, mesh_self_node_id(), bss->band);
		if (verdict != ADMIT_OK)
			policy_evict(sta, bss, verdict);
		else
			policy_mesh_measure(sta, bss, &beacon_budget);
	}

	if (!config.bss_transition || !config.band_steering || config.prefer == PREFER_NONE)
		return;

	target = roam_bss_steer_target(bss);
	if (!target)
		return;

	avl_for_each_element(&roam_sta_tree, sta, avl) {
		struct roam_air cur_air, neu_air;
		bool signal_leave, leave, load_only = false;
		int here, there, gain;
		bool dying;

		if (sta->bss != bss)
			continue;

		if (roam_admit(sta->addr, mesh_self_node_id(), target->band) != ADMIT_OK)
			continue;

		if (roam_now - sta->connected_since < config.hold_time)
			continue;

		if (sta->give_up_until) {
			if (roam_now < sta->give_up_until)
				continue;

			sta->give_up_until = 0;
		}

		if (!roam_policy_can_steer(sta))
			continue;

		if (!band_info_fresh(&sta->band[target->band], target->band))
			policy_beacon_request(sta, bss, target, &beacon_budget);

		roam_bss_air(bss, &cur_air);
		roam_bss_air(target, &neu_air);
		here = sta->band[bss->band].signal;
		there = sta->band[target->band].signal;
		dying = here != ROAMD_NO_SIGNAL && here < config.kick_rssi;
		gain = (here == ROAMD_NO_SIGNAL || there == ROAMD_NO_SIGNAL) ? 0 : there - here;

		signal_leave = sta_should_leave(sta, bss, target);
		leave = signal_leave;

		/* a small signal gain does not justify a busier channel */
		if (leave && roam_air_busy(&neu_air) && !roam_air_busy(&cur_air) &&
		    !dying && gain < config.rssi_diff)
			leave = false;

		/* a busy channel is a reason to ask for a quieter one */
		if (!leave && roam_air_busy(&cur_air) && !roam_air_busy(&neu_air) &&
		    band_info_fresh(&sta->band[target->band], target->band) &&
		    there >= config.rssi_low &&
		    (here == ROAMD_NO_SIGNAL || here - there < config.rssi_diff)) {
			leave = true;
			load_only = true;
		}

		if (!leave && roam_air_lighter(&cur_air, &neu_air) && !roam_air_busy(&neu_air) &&
		    band_info_fresh(&sta->band[target->band], target->band) &&
		    there >= config.rssi_low &&
		    (here == ROAMD_NO_SIGNAL || there >= here)) {
			leave = true;
			load_only = true;
		}

		if (!leave)
			continue;

		if (roam_policy_rate_busy(sta->rx_rate_kbit, sta->rx_rate_known)) {
			roam_log(ROAM_L_DEBUG,
				 "roamd: %s receives %u Mbit/s on %s, not steering",
				 sta->mac, sta->rx_rate_kbit / 1000, bss->ifname);
			continue;
		}

		if (!sta->btm) {
			/* load only asks; it never disconnects */
			if (signal_leave && !load_only && config.allow_kick)
				roam_policy_kick(sta, bss);
			continue;
		}

		policy_btm(sta, bss, target);
	}
}
