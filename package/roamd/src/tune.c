#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tune.h"

#define TUNE_CLIENT_MAX	48
#define TUNE_STEER_MAX	4
#define TUNE_FAIL_MAX	32

struct tune_steer {
	uint32_t ts;
	char node[TUNE_NAME_MAX];
	char target[TUNE_NAME_MAX];
	uint8_t to_band;
	bool band_specific;
	bool resolved;
};

struct tune_client {
	char mac[TUNE_MAC_MAX];
	bool placed;
	bool left;
	bool have_kick;
	bool have_move;
	char node[TUNE_NAME_MAX];
	char left_node[TUNE_NAME_MAX];
	char move_from[TUNE_NAME_MAX];
	char move_to[TUNE_NAME_MAX];
	uint8_t band;
	uint8_t left_band;
	uint8_t move_kind;
	uint8_t move_band_from;
	uint8_t move_band_to;
	uint32_t left_ts;
	uint32_t kick_ts;
	uint32_t move_ts;
	int n_steers;
	struct tune_steer steers[TUNE_STEER_MAX];
};

struct tune_pair {
	char a[TUNE_NAME_MAX];
	char b[TUNE_NAME_MAX];
	uint8_t kind;
	uint8_t band_a;
	uint8_t band_b;
	int sticky_ab;
	int sticky_ba;
	int pingpong;
	int action;
};

struct tune_fail {
	char node[TUNE_NAME_MAX];
	int n;
};

struct tune_work {
	struct tune_event ev[TUNE_EVENT_MAX];
	struct tune_client clients[TUNE_CLIENT_MAX];
	struct tune_pair pairs[TUNE_PAIR_MAX];
	struct tune_fail fails[TUNE_FAIL_MAX];
	int n_clients;
	int n_pairs;
	int n_fails;
	struct tune_result *out;
};

static bool within(uint32_t now, uint32_t then, uint32_t window)
{
	return now >= then && now - then <= window;
}

static bool band_ok(uint8_t band)
{
	return band < 3;
}

static void name_copy(char *dst, const char *src)
{
	if (!src || !src[0])
		snprintf(dst, TUNE_NAME_MAX, "controller");
	else
		snprintf(dst, TUNE_NAME_MAX, "%s", src);
}

static int cmp_ev(const void *a, const void *b)
{
	const struct tune_event *ea = a, *eb = b;
	int c = strcmp(ea->mac, eb->mac);

	if (c)
		return c;
	if (ea->ts < eb->ts)
		return -1;
	if (ea->ts > eb->ts)
		return 1;
	if (ea->seq < eb->seq)
		return -1;
	if (ea->seq > eb->seq)
		return 1;

	return 0;
}

static struct tune_client *client_get(struct tune_work *w, const char *mac)
{
	int i;

	for (i = 0; i < w->n_clients; i++)
		if (!strcmp(w->clients[i].mac, mac))
			return &w->clients[i];

	if (w->n_clients >= TUNE_CLIENT_MAX)
		return NULL;

	memset(&w->clients[w->n_clients], 0, sizeof(w->clients[0]));
	snprintf(w->clients[w->n_clients].mac, TUNE_MAC_MAX, "%s", mac);

	return &w->clients[w->n_clients++];
}

static void fail_add(struct tune_work *w, const char *node)
{
	int i;

	for (i = 0; i < w->n_fails; i++) {
		if (!strcmp(w->fails[i].node, node)) {
			w->fails[i].n++;
			return;
		}
	}

	if (w->n_fails >= TUNE_FAIL_MAX)
		return;

	name_copy(w->fails[w->n_fails].node, node);
	w->fails[w->n_fails].n = 1;
	w->n_fails++;
}

static int fail_count(const struct tune_work *w, const char *node)
{
	int i;

	for (i = 0; i < w->n_fails; i++)
		if (!strcmp(w->fails[i].node, node))
			return w->fails[i].n;

	return 0;
}

static struct tune_pair *pair_find(struct tune_work *w, uint8_t kind,
				   const char *a, const char *b,
				   uint8_t band_a, uint8_t band_b, bool create)
{
	int i;

	for (i = 0; i < w->n_pairs; i++) {
		struct tune_pair *p = &w->pairs[i];

		if (p->kind != kind || strcmp(p->a, a) || strcmp(p->b, b))
			continue;
		if (kind == TUNE_KIND_BAND && (p->band_a != band_a || p->band_b != band_b))
			continue;

		return p;
	}

	if (!create || w->n_pairs >= TUNE_PAIR_MAX)
		return NULL;

	memset(&w->pairs[w->n_pairs], 0, sizeof(w->pairs[0]));
	w->pairs[w->n_pairs].kind = kind;
	name_copy(w->pairs[w->n_pairs].a, a);
	name_copy(w->pairs[w->n_pairs].b, b);
	w->pairs[w->n_pairs].band_a = band_a;
	w->pairs[w->n_pairs].band_b = band_b;

	return &w->pairs[w->n_pairs++];
}

static void pair_sticky(struct tune_work *w, uint8_t kind,
			const char *from, const char *to,
			uint8_t band_from, uint8_t band_to)
{
	struct tune_pair *p;
	bool forward;
	char a[TUNE_NAME_MAX], b[TUNE_NAME_MAX];
	uint8_t lo, hi;

	if (kind == TUNE_KIND_NODE) {
		if (!strcmp(from, to))
			return;
		if (strcmp(from, to) < 0) {
			name_copy(a, from);
			name_copy(b, to);
			forward = true;
		} else {
			name_copy(a, to);
			name_copy(b, from);
			forward = false;
		}
		p = pair_find(w, kind, a, b, 0, 0, true);
	} else {
		lo = band_from < band_to ? band_from : band_to;
		hi = band_from < band_to ? band_to : band_from;
		forward = band_from == lo;
		p = pair_find(w, kind, from, from, lo, hi, true);
	}

	if (!p)
		return;

	if (forward)
		p->sticky_ab++;
	else
		p->sticky_ba++;

	w->out->sticky++;
}

static void pair_pong(struct tune_work *w, uint8_t kind,
		      const char *from, const char *to,
		      uint8_t band_from, uint8_t band_to)
{
	struct tune_pair *p;
	char a[TUNE_NAME_MAX], b[TUNE_NAME_MAX];
	uint8_t lo, hi;

	if (kind == TUNE_KIND_NODE) {
		if (!strcmp(from, to))
			return;
		if (strcmp(from, to) < 0) {
			name_copy(a, from);
			name_copy(b, to);
		} else {
			name_copy(a, to);
			name_copy(b, from);
		}
		p = pair_find(w, kind, a, b, 0, 0, true);
	} else {
		lo = band_from < band_to ? band_from : band_to;
		hi = band_from < band_to ? band_to : band_from;
		p = pair_find(w, kind, from, from, lo, hi, true);
	}

	if (!p)
		return;

	p->pingpong++;
	w->out->pingpong++;
}

static bool move_is_reverse(const struct tune_client *c, uint8_t kind,
			    const char *from, const char *to,
			    uint8_t band_from, uint8_t band_to)
{
	if (!c->have_move || c->move_kind != kind)
		return false;

	if (kind == TUNE_KIND_NODE)
		return !strcmp(c->move_from, to) && !strcmp(c->move_to, from);

	return !strcmp(c->move_from, from) &&
	       c->move_band_from == band_to && c->move_band_to == band_from;
}

static void match_steers(struct tune_client *c, const char *from_node,
			 const char *dest_node, uint8_t dest_band,
			 bool band_move, uint32_t ts)
{
	int i;

	for (i = 0; i < c->n_steers; i++) {
		struct tune_steer *s = &c->steers[i];

		if (s->resolved || strcmp(s->node, from_node))
			continue;
		if (!within(ts, s->ts, TUNE_STEER_WINDOW))
			continue;
		if (s->target[0] && strcmp(s->target, dest_node))
			continue;
		if (s->band_specific && (!band_move || dest_band != s->to_band))
			continue;

		s->resolved = true;
	}
}

static void record_move(struct tune_work *w, struct tune_client *c, uint8_t kind,
			const char *from, const char *to,
			uint8_t band_from, uint8_t band_to, uint32_t ts)
{
	bool band_move = kind == TUNE_KIND_BAND;

	if (c->have_kick) {
		if (within(ts, c->kick_ts, TUNE_KICK_WINDOW))
			return;
		c->have_kick = false;
	}

	w->out->moves++;
	match_steers(c, from, to, band_to, band_move, ts);

	if (c->have_move && move_is_reverse(c, kind, from, to, band_from, band_to) &&
	    within(ts, c->move_ts, TUNE_PINGPONG_WINDOW)) {
		pair_pong(w, kind, from, to, band_from, band_to);
		c->have_move = false;
		return;
	}

	if (c->have_move) {
		/* A return at exactly the window still counts as a ping-pong,
		 * so a stay needs to outlast the window. */
		if (ts >= c->move_ts && ts - c->move_ts > TUNE_PINGPONG_WINDOW)
			pair_sticky(w, c->move_kind, c->move_from, c->move_to,
				    c->move_band_from, c->move_band_to);
		else
			w->out->pending++;
		c->have_move = false;
	}

	c->have_move = true;
	c->move_kind = kind;
	c->move_ts = ts;
	name_copy(c->move_from, from);
	name_copy(c->move_to, to);
	c->move_band_from = band_from;
	c->move_band_to = band_to;
}

static void note_steer(struct tune_client *c, const struct tune_event *ev)
{
	struct tune_steer *s;
	char from[TUNE_NAME_MAX], to[TUNE_NAME_MAX];

	if (c->n_steers >= TUNE_STEER_MAX) {
		memmove(&c->steers[0], &c->steers[1],
			(TUNE_STEER_MAX - 1) * sizeof(c->steers[0]));
		c->n_steers = TUNE_STEER_MAX - 1;
	}

	s = &c->steers[c->n_steers++];
	memset(s, 0, sizeof(*s));
	s->ts = ev->ts;
	name_copy(from, ev->from_node[0] ? ev->from_node : ev->to_node);
	name_copy(s->node, from);
	name_copy(to, ev->to_node[0] ? ev->to_node : ev->from_node);
	if (strcmp(from, to))
		name_copy(s->target, to);
	if (band_ok(ev->to_band) && ev->to_band != ev->from_band) {
		s->band_specific = true;
		s->to_band = ev->to_band;
	}
}

static void finish_client(struct tune_work *w, struct tune_client *c, uint32_t log_end)
{
	int i;

	if (c->have_move) {
		if (log_end >= c->move_ts && log_end - c->move_ts > TUNE_PINGPONG_WINDOW)
			pair_sticky(w, c->move_kind, c->move_from, c->move_to,
				    c->move_band_from, c->move_band_to);
		else
			w->out->pending++;
		c->have_move = false;
	}

	for (i = 0; i < c->n_steers; i++) {
		struct tune_steer *s = &c->steers[i];

		if (s->resolved)
			continue;
		if (log_end >= s->ts && log_end - s->ts >= TUNE_STEER_WINDOW) {
			fail_add(w, s->node);
			w->out->failed++;
		} else {
			w->out->pending++;
		}
	}
}

static const char *event_node(const struct tune_event *ev, char *buf, bool dest)
{
	const char *src = dest ? ev->to_node : ev->from_node;

	if (!src[0])
		src = dest ? ev->from_node : ev->to_node;

	name_copy(buf, src);

	return buf;
}

static void on_disconnect(struct tune_client *c, const struct tune_event *ev)
{
	char node[TUNE_NAME_MAX];

	event_node(ev, node, false);
	c->left = true;
	name_copy(c->left_node, node);
	c->left_band = band_ok(ev->from_band) ? ev->from_band : c->band;
	c->left_ts = ev->ts;
	c->placed = false;
}

static void place(struct tune_client *c, const char *node, uint8_t band)
{
	c->placed = true;
	c->left = false;
	name_copy(c->node, node);
	if (band_ok(band))
		c->band = band;
}

static void on_connect(struct tune_work *w, struct tune_client *c, const struct tune_event *ev)
{
	char node[TUNE_NAME_MAX];
	uint8_t band = band_ok(ev->to_band) ? ev->to_band : ev->from_band;

	event_node(ev, node, true);

	if (c->left && within(ev->ts, c->left_ts, TUNE_MOVE_WINDOW)) {
		if (strcmp(c->left_node, node))
			record_move(w, c, TUNE_KIND_NODE, c->left_node, node,
				    c->left_band, band, ev->ts);
		else if (band_ok(c->left_band) && band_ok(band) && c->left_band != band)
			record_move(w, c, TUNE_KIND_BAND, node, node,
				    c->left_band, band, ev->ts);
	} else if (c->placed && strcmp(c->node, node)) {
		record_move(w, c, TUNE_KIND_NODE, c->node, node, c->band, band, ev->ts);
	}

	place(c, node, band);
}

static void on_roam(struct tune_work *w, struct tune_client *c, const struct tune_event *ev)
{
	char from[TUNE_NAME_MAX], to[TUNE_NAME_MAX];

	event_node(ev, from, false);
	event_node(ev, to, true);

	if (strcmp(from, to))
		record_move(w, c, TUNE_KIND_NODE, from, to, ev->from_band, ev->to_band, ev->ts);
	else if (band_ok(ev->from_band) && band_ok(ev->to_band) && ev->from_band != ev->to_band)
		record_move(w, c, TUNE_KIND_BAND, from, from, ev->from_band, ev->to_band, ev->ts);

	place(c, to, ev->to_band);
}

static void vote_pair(struct tune_work *w, struct tune_pair *p, int *ease, int *tighten)
{
	int winner, loser;
	const char *source;
	bool ab_wins;

	if (p->pingpong >= TUNE_PINGPONG_MIN) {
		p->action = TUNE_TIGHTEN;
		(*tighten)++;
		return;
	}

	if (p->pingpong)
		return;

	ab_wins = p->sticky_ab >= p->sticky_ba;
	winner = ab_wins ? p->sticky_ab : p->sticky_ba;
	loser = ab_wins ? p->sticky_ba : p->sticky_ab;

	if (winner < TUNE_STICKY_MIN || winner <= loser)
		return;

	if (p->kind == TUNE_KIND_BAND)
		source = p->a;
	else
		source = ab_wins ? p->a : p->b;

	if (fail_count(w, source) >= winner)
		return;

	p->action = TUNE_EASE;
	(*ease)++;
}

static int steps_of(int ease, int tighten)
{
	if (tighten > 0)
		return -(tighten < TUNE_MAX_STEPS ? tighten : TUNE_MAX_STEPS);
	if (ease > 0)
		return ease < TUNE_MAX_STEPS ? ease : TUNE_MAX_STEPS;

	return 0;
}

static int clamp_int(int v, int lo, int hi)
{
	if (v < lo)
		return lo;
	if (v > hi)
		return hi;

	return v;
}

static int clamp_rssi(int v, int rssi_good, int kick)
{
	int lo = TUNE_RSSI_LOW_MIN, hi = TUNE_RSSI_LOW_MAX;

	if (kick < 0 && kick + 1 > lo)
		lo = kick + 1;
	if (rssi_good < 0 && rssi_good - 10 < hi)
		hi = rssi_good - 10;
	if (lo > hi) {
		lo = TUNE_RSSI_LOW_MIN;
		hi = TUNE_RSSI_LOW_MAX;
	}

	return clamp_int(v, lo, hi);
}

static void apply_steps(struct tune_result *out, int node_steps, int band_steps,
			int rssi_steps, int rssi_good, int kick)
{
	if (node_steps) {
		out->node_diff_set = true;
		out->node_rssi_diff = clamp_int(TUNE_NODE_DIFF_DEFAULT - TUNE_STEP_DB * node_steps,
						TUNE_NODE_DIFF_MIN, TUNE_NODE_DIFF_MAX);
	} else {
		out->node_rssi_diff = TUNE_NODE_DIFF_DEFAULT;
	}

	if (band_steps) {
		out->band_diff_set = true;
		out->rssi_diff = clamp_int(TUNE_BAND_DIFF_DEFAULT - TUNE_STEP_DB * band_steps,
					   TUNE_BAND_DIFF_MIN, TUNE_BAND_DIFF_MAX);
	} else {
		out->rssi_diff = TUNE_BAND_DIFF_DEFAULT;
	}

	if (rssi_steps) {
		out->rssi_low_set = true;
		out->rssi_low = clamp_rssi(TUNE_RSSI_LOW_DEFAULT + TUNE_STEP_DB * rssi_steps,
					   rssi_good, kick);
	} else {
		out->rssi_low = TUNE_RSSI_LOW_DEFAULT;
	}
}

void tune_evaluate(const struct tune_event *ev, unsigned int n,
		   int rssi_good, int kick_rssi, struct tune_result *out)
{
	struct tune_work *w;
	struct tune_client *cur = NULL;
	uint32_t log_end = 0;
	int node_ease = 0, node_tighten = 0, band_ease = 0, band_tighten = 0;
	int rssi_ease = 0, rssi_tighten = 0;
	unsigned int i;

	if (!out)
		return;

	memset(out, 0, sizeof(*out));
	out->rssi_low = TUNE_RSSI_LOW_DEFAULT;
	out->node_rssi_diff = TUNE_NODE_DIFF_DEFAULT;
	out->rssi_diff = TUNE_BAND_DIFF_DEFAULT;

	if (!ev || !n)
		return;

	if (n > TUNE_EVENT_MAX) {
		ev += n - TUNE_EVENT_MAX;
		n = TUNE_EVENT_MAX;
	}

	w = calloc(1, sizeof(*w));
	if (!w)
		return;

	w->out = out;
	memcpy(w->ev, ev, n * sizeof(*ev));
	qsort(w->ev, n, sizeof(w->ev[0]), cmp_ev);

	for (i = 0; i < n; i++)
		if (w->ev[i].ts > log_end)
			log_end = w->ev[i].ts;

	for (i = 0; i < n; i++) {
		const struct tune_event *e = &w->ev[i];

		if (!e->mac[0] || !e->ts)
			continue;

		if (!cur || strcmp(cur->mac, e->mac)) {
			if (cur)
				finish_client(w, cur, log_end);
			cur = client_get(w, e->mac);
		}

		if (!cur)
			continue;

		switch (e->type) {
		case TUNE_DISCONNECT:
			on_disconnect(cur, e);
			break;
		case TUNE_CONNECT:
			on_connect(w, cur, e);
			break;
		case TUNE_ROAM:
			on_roam(w, cur, e);
			break;
		case TUNE_STEER:
			note_steer(cur, e);
			break;
		case TUNE_KICK:
			/* A kick cuts the stay short. Don't treat that stay as
			 * evidence, and don't treat the forced hop as one either. */
			cur->have_kick = true;
			cur->kick_ts = e->ts;
			cur->have_move = false;
			break;
		default:
			break;
		}
	}

	if (cur)
		finish_client(w, cur, log_end);

	for (i = 0; i < (unsigned int)w->n_pairs; i++) {
		struct tune_pair *p = &w->pairs[i];

		if (p->kind == TUNE_KIND_NODE)
			vote_pair(w, p, &node_ease, &node_tighten);
		else
			vote_pair(w, p, &band_ease, &band_tighten);

		if (out->n_pairs < TUNE_PAIR_MAX) {
			struct tune_pair_result *r = &out->pairs[out->n_pairs++];

			snprintf(r->a, sizeof(r->a), "%s", p->a);
			snprintf(r->b, sizeof(r->b), "%s", p->b);
			r->kind = p->kind;
			r->band_a = p->band_a;
			r->band_b = p->band_b;
			r->sticky_ab = p->sticky_ab;
			r->sticky_ba = p->sticky_ba;
			r->pingpong = p->pingpong;
			r->action = p->action;
		}
	}

	if (node_ease)
		rssi_ease = node_ease;
	if (band_ease > rssi_ease)
		rssi_ease = band_ease;
	if (node_tighten > rssi_tighten)
		rssi_tighten = node_tighten;
	if (band_tighten > rssi_tighten)
		rssi_tighten = band_tighten;

	apply_steps(out, steps_of(node_ease, node_tighten),
		    steps_of(band_ease, band_tighten),
		    steps_of(rssi_ease, rssi_tighten),
		    rssi_good, kick_rssi);

	free(w);
}
