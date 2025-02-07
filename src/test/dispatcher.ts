/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import child_process from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import { RunPayload, TestBeginPayload, TestEndPayload, DonePayload, TestOutputPayload, WorkerInitParams } from './ipc';
import type { TestResult, Reporter } from '../../types/testReporter';
import { TestCase } from './test';
import { Loader } from './loader';

export type TestGroup = {
  workerHash: string;
  requireFile: string;
  repeatEachIndex: number;
  projectIndex: number;
  tests: TestCase[];
};

export class Dispatcher {
  private _workers = new Set<Worker>();
  private _freeWorkers: Worker[] = [];
  private _workerClaimers: (() => void)[] = [];

  private _testById = new Map<string, { test: TestCase, result: TestResult }>();
  private _queue: TestGroup[] = [];
  private _stopCallback = () => {};
  readonly _loader: Loader;
  private _reporter: Reporter;
  private _hasWorkerErrors = false;
  private _isStopped = false;
  private _failureCount = 0;

  constructor(loader: Loader, testGroups: TestGroup[], reporter: Reporter) {
    this._loader = loader;
    this._reporter = reporter;
    this._queue = testGroups;
    for (const group of testGroups) {
      for (const test of group.tests) {
        const result = test._appendTestResult();
        this._testById.set(test._id, { test, result });
      }
    }
  }

  async run() {
    // Loop in case job schedules more jobs
    while (this._queue.length && !this._isStopped)
      await this._dispatchQueue();
  }

  async _dispatchQueue() {
    const jobs = [];
    while (this._queue.length) {
      if (this._isStopped)
        break;
      const testGroup = this._queue.shift()!;
      const requiredHash = testGroup.workerHash;
      let worker = await this._obtainWorker(testGroup);
      while (!this._isStopped && worker.hash && worker.hash !== requiredHash) {
        worker.stop();
        worker = await this._obtainWorker(testGroup);
      }
      if (this._isStopped)
        break;
      jobs.push(this._runJob(worker, testGroup));
    }
    await Promise.all(jobs);
  }

  async _runJob(worker: Worker, testGroup: TestGroup) {
    worker.run(testGroup);

    let doneCallback = () => {};
    const result = new Promise<void>(f => doneCallback = f);
    const doneWithJob = () => {
      worker.removeListener('testBegin', onTestBegin);
      worker.removeListener('testEnd', onTestEnd);
      worker.removeListener('done', onDone);
      worker.removeListener('exit', onExit);
      doneCallback();
    };

    const remainingByTestId = new Map(testGroup.tests.map(e => [ e._id, e ]));
    let lastStartedTestId: string | undefined;

    const onTestBegin = (params: TestBeginPayload) => {
      lastStartedTestId = params.testId;
    };
    worker.addListener('testBegin', onTestBegin);

    const onTestEnd = (params: TestEndPayload) => {
      remainingByTestId.delete(params.testId);
    };
    worker.addListener('testEnd', onTestEnd);

    const onDone = (params: DonePayload) => {
      let remaining = [...remainingByTestId.values()];

      // We won't file remaining if:
      // - there are no remaining
      // - we are here not because something failed
      // - no unrecoverable worker error
      if (!remaining.length && !params.failedTestId && !params.fatalError) {
        this._freeWorkers.push(worker);
        this._notifyWorkerClaimer();
        doneWithJob();
        return;
      }

      // When worker encounters error, we will stop it and create a new one.
      worker.stop();

      const failedTestIds = new Set<string>();

      // In case of fatal error, report first remaining test as failing with this error,
      // and all others as skipped.
      if (params.fatalError) {
        let first = true;
        for (const test of remaining) {
          const { result } = this._testById.get(test._id)!;
          if (this._hasReachedMaxFailures())
            break;
          // There might be a single test that has started but has not finished yet.
          if (test._id !== lastStartedTestId)
            this._reporter.onTestBegin?.(test);
          result.error = params.fatalError;
          result.status = first ? 'failed' : 'skipped';
          this._reportTestEnd(test, result);
          failedTestIds.add(test._id);
          first = false;
        }
        // Since we pretend that all remaining tests failed, there is nothing else to run,
        // except for possible retries.
        remaining = [];
      }
      if (params.failedTestId)
        failedTestIds.add(params.failedTestId);

      // Only retry expected failures, not passes and only if the test failed.
      for (const testId of failedTestIds) {
        const pair = this._testById.get(testId)!;
        if (!this._isStopped && pair.test.expectedStatus === 'passed' && pair.test.results.length < pair.test.retries + 1) {
          pair.result = pair.test._appendTestResult();
          remaining.unshift(pair.test);
        }
      }

      if (remaining.length)
        this._queue.unshift({ ...testGroup, tests: remaining });

      // This job is over, we just scheduled another one.
      doneWithJob();
    };
    worker.on('done', onDone);

    const onExit = () => {
      if (worker.didSendStop)
        onDone({});
      else
        onDone({ fatalError: { value: 'Worker process exited unexpectedly' } });
    };
    worker.on('exit', onExit);

    return result;
  }

  async _obtainWorker(testGroup: TestGroup) {
    const claimWorker = (): Promise<Worker> | null => {
      // Use available worker.
      if (this._freeWorkers.length)
        return Promise.resolve(this._freeWorkers.pop()!);
      // Create a new worker.
      if (this._workers.size < this._loader.fullConfig().workers)
        return this._createWorker(testGroup);
      return null;
    };

    // Note: it is important to claim the worker synchronously,
    // so that we won't miss a _notifyWorkerClaimer call while awaiting.
    let worker = claimWorker();
    if (!worker) {
      // Wait for available or stopped worker.
      await new Promise<void>(f => this._workerClaimers.push(f));
      worker = claimWorker();
    }
    return worker!;
  }

  async _notifyWorkerClaimer() {
    if (this._isStopped || !this._workerClaimers.length)
      return;
    const callback = this._workerClaimers.shift()!;
    callback();
  }

  _createWorker(testGroup: TestGroup) {
    const worker = new Worker(this);
    worker.on('testBegin', (params: TestBeginPayload) => {
      if (this._hasReachedMaxFailures())
        return;
      const { test, result: testRun  } = this._testById.get(params.testId)!;
      testRun.workerIndex = params.workerIndex;
      testRun.startTime = new Date(params.startWallTime);
      this._reporter.onTestBegin?.(test);
    });
    worker.on('testEnd', (params: TestEndPayload) => {
      if (this._hasReachedMaxFailures())
        return;
      const { test, result } = this._testById.get(params.testId)!;
      result.duration = params.duration;
      result.error = params.error;
      result.attachments = params.attachments.map(a => ({
        name: a.name,
        path: a.path,
        contentType: a.contentType,
        body: a.body ? Buffer.from(a.body, 'base64') : undefined
      }));
      result.status = params.status;
      test.expectedStatus = params.expectedStatus;
      test.annotations = params.annotations;
      test.timeout = params.timeout;
      this._reportTestEnd(test, result);
    });
    worker.on('stdOut', (params: TestOutputPayload) => {
      const chunk = chunkFromParams(params);
      const pair = params.testId ? this._testById.get(params.testId) : undefined;
      if (pair)
        pair.result.stdout.push(chunk);
      this._reporter.onStdOut?.(chunk, pair ? pair.test : undefined);
    });
    worker.on('stdErr', (params: TestOutputPayload) => {
      const chunk = chunkFromParams(params);
      const pair = params.testId ? this._testById.get(params.testId) : undefined;
      if (pair)
        pair.result.stderr.push(chunk);
      this._reporter.onStdErr?.(chunk, pair ? pair.test : undefined);
    });
    worker.on('teardownError', ({error}) => {
      this._hasWorkerErrors = true;
      this._reporter.onError?.(error);
    });
    worker.on('exit', () => {
      this._workers.delete(worker);
      this._notifyWorkerClaimer();
      if (this._stopCallback && !this._workers.size)
        this._stopCallback();
    });
    this._workers.add(worker);
    return worker.init(testGroup).then(() => worker);
  }

  async stop() {
    this._isStopped = true;
    if (this._workers.size) {
      const result = new Promise<void>(f => this._stopCallback = f);
      for (const worker of this._workers)
        worker.stop();
      await result;
    }
  }

  private _hasReachedMaxFailures() {
    const maxFailures = this._loader.fullConfig().maxFailures;
    return maxFailures > 0 && this._failureCount >= maxFailures;
  }

  private _reportTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'skipped' && result.status !== test.expectedStatus)
      ++this._failureCount;
    this._reporter.onTestEnd?.(test, result);
    const maxFailures = this._loader.fullConfig().maxFailures;
    if (maxFailures && this._failureCount === maxFailures)
      this.stop().catch(e => {});
  }

  hasWorkerErrors(): boolean {
    return this._hasWorkerErrors;
  }
}

let lastWorkerIndex = 0;

class Worker extends EventEmitter {
  process: child_process.ChildProcess;
  runner: Dispatcher;
  hash = '';
  index: number;
  didSendStop = false;

  constructor(runner: Dispatcher) {
    super();
    this.runner = runner;
    this.index = lastWorkerIndex++;

    this.process = child_process.fork(path.join(__dirname, 'worker.js'), {
      detached: false,
      env: {
        FORCE_COLOR: process.stdout.isTTY ? '1' : '0',
        DEBUG_COLORS: process.stdout.isTTY ? '1' : '0',
        TEST_WORKER_INDEX: String(this.index),
        ...process.env
      },
      // Can't pipe since piping slows down termination for some reason.
      stdio: ['ignore', 'ignore', process.env.PW_RUNNER_DEBUG ? 'inherit' : 'ignore', 'ipc']
    });
    this.process.on('exit', () => this.emit('exit'));
    this.process.on('error', e => {});  // do not yell at a send to dead process.
    this.process.on('message', (message: any) => {
      const { method, params } = message;
      this.emit(method, params);
    });
  }

  async init(testGroup: TestGroup) {
    this.hash = testGroup.workerHash;
    const params: WorkerInitParams = {
      workerIndex: this.index,
      repeatEachIndex: testGroup.repeatEachIndex,
      projectIndex: testGroup.projectIndex,
      loader: this.runner._loader.serialize(),
    };
    this.process.send({ method: 'init', params });
    await new Promise(f => this.process.once('message', f));  // Ready ack
  }

  run(testGroup: TestGroup) {
    const runPayload: RunPayload = {
      file: testGroup.requireFile,
      entries: testGroup.tests.map(test => {
        return { testId: test._id, retry: test.results.length - 1 };
      }),
    };
    this.process.send({ method: 'run', params: runPayload });
  }

  stop() {
    if (!this.didSendStop)
      this.process.send({ method: 'stop' });
    this.didSendStop = true;
  }
}

function chunkFromParams(params: TestOutputPayload): string | Buffer {
  if (typeof params.text === 'string')
    return params.text;
  return Buffer.from(params.buffer!, 'base64');
}
