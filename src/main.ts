import * as core from '@actions/core'
import * as github from '@actions/github'
import {GitHub} from '@actions/github/lib/utils'

import {ArtifactProvider} from './input-providers/artifact-provider'
import {LocalFileProvider} from './input-providers/local-file-provider'
import {FileContent} from './input-providers/input-provider'
import {ParseOptions, TestParser} from './test-parser'
import {TestRunResult} from './test-results'
import {getAnnotations} from './report/get-annotations'
import {getReport} from './report/get-report'

import {DartJsonParser} from './parsers/dart-json/dart-json-parser'
import {DotnetTrxParser} from './parsers/dotnet-trx/dotnet-trx-parser'
import {JestJunitParser} from './parsers/jest-junit/jest-junit-parser'

import {normalizeDirPath} from './utils/path-utils'
import {getCheckRunContext} from './utils/github-utils'
import {Icon} from './utils/markdown-utils'

async function main(): Promise<void> {
  try {
    const testReporter = new TestReporter()
    await testReporter.run()
  } catch (error) {
    core.setFailed(error.message)
  }
}

class TestReporter {
  readonly artifact = core.getInput('artifact', {required: false})
  readonly name = core.getInput('name', {required: true})
  readonly path = core.getInput('path', {required: true})
  readonly reporter = core.getInput('reporter', {required: true})
  readonly listSuites = core.getInput('list-suites', {required: true}) as 'all' | 'failed'
  readonly listTests = core.getInput('list-tests', {required: true}) as 'all' | 'failed' | 'none'
  readonly maxAnnotations = parseInt(core.getInput('max-annotations', {required: true}))
  readonly failOnError = core.getInput('fail-on-error', {required: true}) === 'true'
  readonly workDirInput = core.getInput('working-directory', {required: false})
  readonly token = core.getInput('token', {required: true})
  readonly octokit: InstanceType<typeof GitHub>
  readonly context = getCheckRunContext()

  constructor() {
    this.octokit = github.getOctokit(this.token)

    if (this.listSuites !== 'all' && this.listSuites !== 'failed') {
      core.setFailed(`Input parameter 'list-suites' has invalid value`)
      return
    }

    if (this.listTests !== 'all' && this.listTests !== 'failed' && this.listTests !== 'none') {
      core.setFailed(`Input parameter 'list-tests' has invalid value`)
      return
    }

    if (isNaN(this.maxAnnotations) || this.maxAnnotations < 0 || this.maxAnnotations > 50) {
      core.setFailed(`Input parameter 'max-annotations' has invalid value`)
      return
    }
  }

  async run(): Promise<void> {
    if (this.workDirInput) {
      core.info(`Changing directory to '${this.workDirInput}'`)
      process.chdir(this.workDirInput)
    }

    core.info(`Check runs will be created with SHA=${this.context.sha}`)

    const pattern = this.path.split(',')
    const inputProvider = this.artifact
      ? new ArtifactProvider(
          this.octokit,
          this.artifact,
          this.name,
          pattern,
          this.context.sha,
          this.context.runId,
          this.token
        )
      : new LocalFileProvider(this.name, pattern)

    const parseErrors = this.maxAnnotations > 0
    const trackedFiles = await inputProvider.listTrackedFiles()
    const workDir = this.artifact ? undefined : normalizeDirPath(process.cwd(), true)

    core.info(`Found ${trackedFiles.length} files tracked by GitHub`)

    const options: ParseOptions = {
      workDir,
      trackedFiles,
      parseErrors
    }

    core.info(`Using test report parser '${this.reporter}'`)
    const parser = this.getParser(this.reporter, options)

    const results: TestRunResult[] = []
    const input = await inputProvider.load()
    for (const [reportName, files] of Object.entries(input)) {
      try {
        core.startGroup(`Creating test report ${reportName}`)
        const tr = await this.createReport(parser, reportName, files)
        results.push(...tr)
      } finally {
        core.endGroup()
      }
    }

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'
    const passed = results.reduce((sum, tr) => sum + tr.passed, 0)
    const failed = results.reduce((sum, tr) => sum + tr.failed, 0)
    const skipped = results.reduce((sum, tr) => sum + tr.skipped, 0)
    const time = results.reduce((sum, tr) => sum + tr.time, 0)

    core.setOutput('conclusion', conclusion)
    core.setOutput('passed', passed)
    core.setOutput('failed', failed)
    core.setOutput('skipped', skipped)
    core.setOutput('time', time)

    if (this.failOnError && isFailed) {
      core.setFailed(`Failed test has been found and 'fail-on-error' option is set to ${this.failOnError}`)
    }
  }

  async createReport(parser: TestParser, name: string, files: FileContent[]): Promise<TestRunResult[]> {
    if (files.length === 0) {
      core.warning(`No file matches path ${this.path}`)
      return []
    }

    const results: TestRunResult[] = []
    for (const {file, content} of files) {
      core.info(`Processing test results from ${file}`)
      const tr = await parser.parse(file, content)
      results.push(tr)
    }

    core.info('Creating report summary')
    const {listSuites, listTests} = this
    const summary = getReport(results, {listSuites, listTests})

    core.info('Creating annotations')
    const annotations = getAnnotations(results, this.maxAnnotations)

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'
    const icon = isFailed ? Icon.fail : Icon.success

    core.info(`Creating check run with conclusion ${conclusion}`)
    const resp = await this.octokit.checks.create({
      head_sha: this.context.sha,
      name,
      conclusion,
      status: 'completed',
      output: {
        title: `${name} ${icon}`,
        summary,
        annotations
      },
      ...github.context.repo
    })
    core.info(`Check run create response: ${resp.status}`)
    core.info(`Check run URL: ${resp.data.url}`)
    core.info(`Check run HTML: ${resp.data.html_url}`)

    return results
  }

  getParser(reporter: string, options: ParseOptions): TestParser {
    switch (reporter) {
      case 'dart-json':
        return new DartJsonParser(options, 'dart')
      case 'dotnet-trx':
        return new DotnetTrxParser(options)
      case 'flutter-json':
        return new DartJsonParser(options, 'flutter')
      case 'jest-junit':
        return new JestJunitParser(options)
      default:
        throw new Error(`Input variable 'reporter' is set to invalid value '${reporter}'`)
    }
  }
}

main()
