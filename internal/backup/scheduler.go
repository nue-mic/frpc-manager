package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/nue-mic/frpc-manager/internal/eventbus"
)

// backupJobTimeout bounds a single backup run (build + upload + retention).
const backupJobTimeout = 10 * time.Minute

// Errors returned by the scheduler API surface.
var (
	ErrScheduleNotFound = errors.New("备份计划不存在")
	ErrAlreadyRunning   = errors.New("该备份计划正在执行中")
)

// Store provides the scheduler with the current persisted channels/schedules.
// It is satisfied by *manager.Manager.
type Store interface {
	GetBackupChannel(id string) (Channel, bool)
	ListBackupSchedules() []Schedule
	GetBackupSchedule(id string) (Schedule, bool)
}

// Source builds the backup payload (the full config export zip).
type Source interface {
	BuildBackupZip(w io.Writer) error
}

// Recorder persists a completed run record (host-local history).
type Recorder interface {
	AppendBackupRun(r RunRecord) error
}

// Scheduler owns the cron registry and executes backup jobs. It is safe for
// concurrent use; all exported methods take the internal lock as needed.
type Scheduler struct {
	store    Store
	source   Source
	recorder Recorder
	bus      *eventbus.Bus
	log      *slog.Logger
	host     string

	rootCtx    context.Context
	rootCancel context.CancelFunc

	mu      sync.Mutex
	cron    *cron.Cron
	started bool
	stopped bool            // set by Stop; blocks new launches so wg can drain
	running map[string]bool // schedule id → in-flight (re-entrancy guard)
	wg      sync.WaitGroup  // tracks in-flight backup goroutines so Stop can join
}

// NewScheduler wires a scheduler. host labels the {host} path token; pass the
// OS hostname. bus/log may be nil (no events / discard).
func NewScheduler(store Store, source Source, recorder Recorder, bus *eventbus.Bus, log *slog.Logger, host string) *Scheduler {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Scheduler{
		store:      store,
		source:     source,
		recorder:   recorder,
		bus:        bus,
		log:        log,
		host:       host,
		rootCtx:    ctx,
		rootCancel: cancel,
		running:    make(map[string]bool),
	}
}

// Start builds the cron registry from the enabled schedules and begins ticking.
func (s *Scheduler) Start() {
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	if err := s.Reload(); err != nil {
		s.log.Warn("backup scheduler initial load failed", slog.Any("err", err))
	}
	s.log.Info("backup scheduler started")
}

// Stop halts cron ticking, cancels in-flight jobs' context, and waits (bounded)
// for them to finish so "stopped" really means quiesced.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	c := s.cron
	s.started = false
	s.stopped = true
	s.cron = nil
	s.mu.Unlock()
	if c != nil {
		c.Stop()
	}
	s.rootCancel()

	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		s.log.Warn("backup scheduler stop: in-flight jobs did not finish in time")
	}
}

// ScopeSignature returns the retention-pool signature of a schedule. Two
// schedules on the same channel with equal signatures would delete each other's
// backups; the API rejects such a collision at save time.
func (s *Scheduler) ScopeSignature(sched Schedule) string {
	return scopeSignature(sched.EffectiveTemplate(), sched.Name, s.host)
}

// Reload rebuilds the cron registry from the current enabled schedules. Call it
// after any channel/schedule change so edits take effect without a restart.
func (s *Scheduler) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cron != nil {
		s.cron.Stop()
		s.cron = nil
	}
	if !s.started {
		return nil
	}
	c := cron.New()
	active := 0
	for _, sched := range s.store.ListBackupSchedules() {
		if !sched.Enabled {
			continue
		}
		sc := sched // capture per iteration
		if _, err := c.AddFunc(sc.Cron, func() { s.launch(sc, TriggerSchedule) }); err != nil {
			s.log.Warn("invalid cron spec, schedule disabled at runtime",
				slog.String("schedule", sc.Name), slog.String("cron", sc.Cron), slog.Any("err", err))
			continue
		}
		active++
	}
	c.Start()
	s.cron = c
	s.log.Info("backup scheduler reloaded", slog.Int("active_schedules", active))
	return nil
}

// RunNow triggers a manual backup for the schedule id. It returns immediately;
// the job runs in the background. ErrAlreadyRunning if one is already in flight.
func (s *Scheduler) RunNow(id string) error {
	sched, ok := s.store.GetBackupSchedule(id)
	if !ok {
		return ErrScheduleNotFound
	}
	if !s.launch(sched, TriggerManual) {
		return ErrAlreadyRunning
	}
	return nil
}

// RunningSchedules returns the ids of schedules with a backup currently running.
func (s *Scheduler) RunningSchedules() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.running))
	for id, on := range s.running {
		if on {
			out = append(out, id)
		}
	}
	return out
}

// TestChannel verifies a channel's connectivity/credentials without writing.
func (s *Scheduler) TestChannel(ctx context.Context, ch Channel) error {
	up, err := NewUploader(ch)
	if err != nil {
		return err
	}
	return up.Test(ctx)
}

// launch starts a backup job for sched unless one is already running for it (or
// the scheduler is stopped). Returns whether the job was started.
func (s *Scheduler) launch(sched Schedule, trigger string) bool {
	s.mu.Lock()
	if s.stopped || s.running[sched.ID] {
		s.mu.Unlock()
		return false
	}
	s.running[sched.ID] = true
	s.wg.Add(1)
	s.mu.Unlock()

	// Tell the UI a run has started, so the running state lights up for
	// scheduled (non-interactive) triggers too — not just manual ones.
	s.publish(RunRecord{ScheduleID: sched.ID, ChannelID: sched.ChannelID,
		Trigger: trigger, Status: StatusRunning, StartedAt: time.Now().Unix()})

	go func() {
		defer s.wg.Done()
		defer func() {
			s.mu.Lock()
			delete(s.running, sched.ID)
			s.mu.Unlock()
		}()
		// A panic in a third-party network library (minio-go/gowebdav) must not
		// take down the whole daemon — recover, log, and record a failed run.
		defer func() {
			if r := recover(); r != nil {
				s.log.Error("backup job panicked",
					slog.String("schedule", sched.Name), slog.Any("recover", r))
				now := time.Now().Unix()
				rec := RunRecord{ID: NewID("run"), ScheduleID: sched.ID, ChannelID: sched.ChannelID,
					Trigger: trigger, Status: StatusFailed, StartedAt: now, FinishedAt: now,
					Error: "备份任务内部错误（panic），已记录"}
				if err := s.recorder.AppendBackupRun(rec); err != nil {
					s.log.Warn("persist panicked backup run failed", slog.Any("err", err))
				}
				s.publish(rec)
			}
		}()
		ctx, cancel := context.WithTimeout(s.rootCtx, backupJobTimeout)
		defer cancel()
		rec := s.execute(ctx, sched, trigger)
		if err := s.recorder.AppendBackupRun(rec); err != nil {
			s.log.Warn("persist backup run failed", slog.Any("err", err))
		}
		s.publish(rec)
	}()
	return true
}

func (s *Scheduler) publish(rec RunRecord) {
	if s.bus != nil {
		s.bus.Publish(eventbus.TypeBackupRun, "", rec)
	}
}

// execute performs one backup end to end and returns its run record.
func (s *Scheduler) execute(ctx context.Context, sched Schedule, trigger string) RunRecord {
	start := time.Now().UTC()
	rec := RunRecord{
		ID:         NewID("run"),
		ScheduleID: sched.ID,
		ChannelID:  sched.ChannelID,
		Trigger:    trigger,
		Status:     StatusRunning,
		StartedAt:  start.Unix(),
	}
	fail := func(msg string) RunRecord {
		rec.Status = StatusFailed
		rec.Error = msg
		rec.FinishedAt = time.Now().Unix()
		s.log.Warn("backup failed", slog.String("schedule", sched.Name), slog.String("err", msg))
		return rec
	}

	ch, ok := s.store.GetBackupChannel(sched.ChannelID)
	if !ok {
		return fail("存储渠道不存在或已被删除")
	}
	up, err := NewUploader(ch)
	if err != nil {
		return fail("初始化存储渠道失败：" + err.Error())
	}

	var buf bytes.Buffer
	if err := s.source.BuildBackupZip(&buf); err != nil {
		return fail("打包配置失败：" + err.Error())
	}
	data := buf.Bytes()
	rec.SizeBytes = int64(len(data))

	key := renderPath(sched.EffectiveTemplate(), sched.Name, s.host, start)
	rec.ObjectPath = key
	if err := up.Put(ctx, key, data); err != nil {
		return fail("上传失败：" + err.Error())
	}

	// Retention is best-effort: a failure here doesn't fail the backup itself.
	s.applyRetention(ctx, up, sched)

	rec.Status = StatusSuccess
	rec.FinishedAt = time.Now().Unix()
	s.log.Info("backup succeeded",
		slog.String("schedule", sched.Name),
		slog.String("channel", ch.Name),
		slog.String("object", key),
		slog.Int64("bytes", rec.SizeBytes))
	return rec
}

// applyRetention deletes backups beyond sched.Retention. It only ever considers
// objects that THIS schedule itself produced — matched against a regexp built
// from its own path template — so it can never delete another schedule's
// backups or unrelated files that happen to share the directory. Survivors are
// chosen by the storage backend's real last-modified time, not by key ordering,
// so a custom template can't trick it into deleting the newest backup.
func (s *Scheduler) applyRetention(ctx context.Context, up Uploader, sched Schedule) {
	if sched.Retention <= 0 {
		return
	}
	tpl := sched.EffectiveTemplate()
	prefix := retentionPrefix(tpl, sched.Name, s.host)
	if prefix == "" {
		s.log.Warn("retention skipped: path template has no stable prefix",
			slog.String("schedule", sched.Name))
		return
	}
	matcher := objectMatcher(tpl, sched.Name, s.host)
	if matcher == nil {
		s.log.Warn("retention skipped: cannot build object matcher from template",
			slog.String("schedule", sched.Name))
		return
	}
	objs, err := up.List(ctx, prefix)
	if err != nil {
		s.log.Warn("retention list failed", slog.String("schedule", sched.Name), slog.Any("err", err))
		return
	}
	mine := objs[:0]
	for _, o := range objs {
		if matcher.MatchString(o.Key) {
			mine = append(mine, o)
		}
	}
	if len(mine) <= sched.Retention {
		return
	}
	// Oldest first by real modification time; key breaks ties deterministically.
	sort.Slice(mine, func(i, j int) bool {
		if !mine[i].Modified.Equal(mine[j].Modified) {
			return mine[i].Modified.Before(mine[j].Modified)
		}
		return mine[i].Key < mine[j].Key
	})
	for _, o := range mine[:len(mine)-sched.Retention] {
		if err := up.Delete(ctx, o.Key); err != nil {
			s.log.Warn("retention delete failed",
				slog.String("schedule", sched.Name), slog.String("object", o.Key), slog.Any("err", err))
		}
	}
}

// ValidateCron reports whether spec is a valid cron expression / descriptor.
func ValidateCron(spec string) error {
	if strings.TrimSpace(spec) == "" {
		return errors.New("cron 表达式不能为空")
	}
	if _, err := cron.ParseStandard(spec); err != nil {
		return errors.New("无效的 cron 表达式：" + err.Error())
	}
	return nil
}
