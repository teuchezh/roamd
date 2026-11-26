#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "roamd.h"
#include "mesh.h"
#include "tune.h"

/* One explicit pass. Writes the policy options the daemon already reads.
 * Does not disconnect a client and does not arm a retry timer. */

struct tune_collect {
	struct tune_event ev[TUNE_EVENT_MAX];
	unsigned int n;
};

static void collect_cb(const struct mesh_event *ev, void *priv)
{
	struct tune_collect *c = priv;
	struct tune_event *d;

	if (c->n >= TUNE_EVENT_MAX)
		return;

	d = &c->ev[c->n];
	memset(d, 0, sizeof(*d));

	switch (ev->type) {
	case MESH_EV_CONNECT:
		d->type = TUNE_CONNECT;
		break;
	case MESH_EV_DISCONNECT:
		d->type = TUNE_DISCONNECT;
		break;
	case MESH_EV_ROAM:
		d->type = TUNE_ROAM;
		break;
	case MESH_EV_STEER:
		d->type = TUNE_STEER;
		break;
	case MESH_EV_KICK:
		d->type = TUNE_KICK;
		break;
	default:
		return;
	}

	d->ts = ev->ts;
	d->seq = ev->seq;
	snprintf(d->mac, sizeof(d->mac), "%s", ev->mac);
	snprintf(d->from_node, sizeof(d->from_node), "%s", ev->from_node);
	snprintf(d->to_node, sizeof(d->to_node), "%s", ev->to_node);
	d->from_band = ev->from_band;
	d->to_band = ev->to_band;
	c->n++;
}

static const char *band_label(uint8_t band)
{
	if (band == BAND_LOW)
		return "2.4";
	if (band == BAND_HIGH)
		return "5";
	if (band == BAND_6)
		return "6";

	return "";
}

static const char *action_name(int action)
{
	if (action == TUNE_EASE)
		return "ease";
	if (action == TUNE_TIGHTEN)
		return "tighten";

	return "none";
}

static void add_knob(struct blob_buf *b, const char *name, bool set, int before, int after)
{
	char from[16], to[16];
	void *t = blobmsg_open_table(b, name);

	snprintf(from, sizeof(from), "%d", before);
	snprintf(to, sizeof(to), "%d", after);
	blobmsg_add_u8(b, "set", set);
	blobmsg_add_string(b, "before", from);
	blobmsg_add_string(b, "after", to);
	blobmsg_close_table(b, t);
}

static bool knob_changed(bool set, int before, int after)
{
	return set && before != after;
}

static const char *overall_action(bool rssi_set, int rssi_before, int rssi_after,
				  bool node_set, int node_before, int node_after,
				  bool band_set, int band_before, int band_after)
{
	int earlier = 0, later = 0;

	if (knob_changed(rssi_set, rssi_before, rssi_after)) {
		if (rssi_after > rssi_before)
			earlier++;
		else
			later++;
	}

	if (knob_changed(node_set, node_before, node_after)) {
		if (node_after < node_before)
			earlier++;
		else
			later++;
	}

	if (knob_changed(band_set, band_before, band_after)) {
		if (band_after < band_before)
			earlier++;
		else
			later++;
	}

	if (earlier && later)
		return "mixed";
	if (earlier)
		return "ease";
	if (later)
		return "tighten";

	return "none";
}

void roam_tune_apply(struct blob_buf *reply)
{
	struct tune_collect *collected = calloc(1, sizeof(*collected));
	struct tune_result *result = calloc(1, sizeof(*result));
	int rssi_before = config.rssi_low;
	int node_before = config.node_rssi_diff;
	int band_before = config.rssi_diff;
	int rssi_after, node_after, band_after;
	bool changed = false;
	const char *action;
	void *arr;
	int i;

	if (!collected || !result) {
		free(collected);
		free(result);
		blobmsg_add_u8(reply, "changed", 0);
		blobmsg_add_string(reply, "action", "none");
		return;
	}

	mesh_log_foreach(collect_cb, collected);
	tune_evaluate(collected->ev, collected->n, config.rssi_good, config.kick_rssi, result);
	free(collected);
	collected = NULL;

	rssi_after = result->rssi_low_set ? result->rssi_low : rssi_before;
	node_after = result->node_diff_set ? result->node_rssi_diff : node_before;
	band_after = result->band_diff_set ? result->rssi_diff : band_before;
	action = overall_action(result->rssi_low_set, rssi_before, rssi_after,
				result->node_diff_set, node_before, node_after,
				result->band_diff_set, band_before, band_after);
	changed = strcmp(action, "none") != 0;

	if (changed) {
		struct uci_session u;
		char value[16];

		if (!uci_session_open(&u, "roamd")) {
			free(result);
			blobmsg_add_u8(reply, "changed", 0);
			blobmsg_add_string(reply, "action", "none");
			return;
		}

		uci_session_add(&u, "policy", "policy");

		if (knob_changed(result->rssi_low_set, rssi_before, rssi_after)) {
			snprintf(value, sizeof(value), "%d", rssi_after);
			uci_session_set(&u, "policy", "rssi_low", value);
		}
		if (knob_changed(result->node_diff_set, node_before, node_after)) {
			snprintf(value, sizeof(value), "%d", node_after);
			uci_session_set(&u, "policy", "node_rssi_diff", value);
		}
		if (knob_changed(result->band_diff_set, band_before, band_after)) {
			snprintf(value, sizeof(value), "%d", band_after);
			uci_session_set(&u, "policy", "rssi_diff", value);
		}

		uci_session_close(&u);
		roam_config_load();
		mesh_ctrl_sync();

		roam_log(ROAM_L_INFO,
			 "roamd: tuned from the transition log, rssi_low %d -> %d, "
			 "node_rssi_diff %d -> %d, rssi_diff %d -> %d",
			 rssi_before, rssi_after, node_before, node_after,
			 band_before, band_after);
	}

	blobmsg_add_u8(reply, "changed", changed);
	blobmsg_add_string(reply, "action", action);
	blobmsg_add_u32(reply, "moves", result->moves);
	blobmsg_add_u32(reply, "sticky", result->sticky);
	blobmsg_add_u32(reply, "failed", result->failed);
	blobmsg_add_u32(reply, "pingpong", result->pingpong);
	blobmsg_add_u32(reply, "pending", result->pending);
	add_knob(reply, "rssi_low", result->rssi_low_set, rssi_before, rssi_after);
	add_knob(reply, "node_rssi_diff", result->node_diff_set, node_before, node_after);
	add_knob(reply, "rssi_diff", result->band_diff_set, band_before, band_after);

	arr = blobmsg_open_array(reply, "pairs");
	for (i = 0; i < result->n_pairs; i++) {
		const struct tune_pair_result *p = &result->pairs[i];
		void *t;

		if (!p->sticky_ab && !p->sticky_ba && !p->pingpong)
			continue;

		t = blobmsg_open_table(reply, NULL);
		blobmsg_add_string(reply, "kind", p->kind == TUNE_KIND_BAND ? "band" : "node");
		blobmsg_add_string(reply, "a", p->a);
		blobmsg_add_string(reply, "b", p->b);
		if (p->kind == TUNE_KIND_BAND) {
			blobmsg_add_string(reply, "band_a", band_label(p->band_a));
			blobmsg_add_string(reply, "band_b", band_label(p->band_b));
		}
		blobmsg_add_u32(reply, "sticky_ab", p->sticky_ab);
		blobmsg_add_u32(reply, "sticky_ba", p->sticky_ba);
		blobmsg_add_u32(reply, "pingpong", p->pingpong);
		blobmsg_add_string(reply, "action", action_name(p->action));
		blobmsg_close_table(reply, t);
	}
	blobmsg_close_array(reply, arr);
	free(result);
}
