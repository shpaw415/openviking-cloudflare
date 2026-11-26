// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useQuerySettlement } from '#/shared/hooks/use-query-settlement'

const scheduled: Array<() => void> = []

afterEach(() => {
  cleanup()
  notifyManager.setScheduler(callback => setTimeout(callback, 0))
  scheduled.splice(0).forEach(callback => callback())
})

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function Directory({ scope, enabled, load }: {
  scope: string
  enabled: boolean
  load: () => Promise<string>
}) {
  const key = ['interactive-fixture', scope]
  const query = useQuery({ queryKey: key, queryFn: load, enabled, retry: false })
  useQuerySettlement(key, enabled)
  return <p role="status">{!enabled ? 'Closed' : query.isError ? 'Unavailable' : query.data ?? 'Loading'}</p>
}

it('renders a settled result before the observer timer is released', async () => {
  notifyManager.setScheduler(callback => scheduled.push(callback))
  const client = new QueryClient()
  const reply = pending<string>()
  const load = vi.fn(() => reply.promise)
  render(<QueryClientProvider client={client}><Directory scope="a" enabled load={load} /></QueryClientProvider>)
  expect(screen.getByRole('status').textContent).toBe('Loading')
  await act(async () => reply.resolve('Approved result'))
  expect(client.getQueryData(['interactive-fixture', 'a'])).toBe('Approved result')
  expect(scheduled.length).toBeGreaterThan(0)
  expect(screen.getByRole('status').textContent).toBe('Approved result')
  expect(load).toHaveBeenCalledTimes(1)
})

it('does not publish the other scope and renders the current refusal before timers', async () => {
  notifyManager.setScheduler(callback => scheduled.push(callback))
  const client = new QueryClient()
  const former = pending<string>(), current = pending<string>()
  const loadA = vi.fn(() => former.promise), loadB = vi.fn(() => current.promise)
  const tree = (scope: string, enabled: boolean, load: () => Promise<string>) => (
    <QueryClientProvider client={client}><Directory scope={scope} enabled={enabled} load={load} /></QueryClientProvider>
  )
  const view = render(tree('a', true, loadA))
  view.rerender(tree('b', false, loadB))
  await act(async () => former.resolve('Old directory'))
  expect(screen.getByRole('status').textContent).toBe('Closed')
  expect(loadB).not.toHaveBeenCalled()
  view.rerender(tree('b', true, loadB))
  expect(screen.getByRole('status').textContent).toBe('Loading')
  await act(async () => current.reject(new Error('Synthetic refusal')))
  expect(scheduled.length).toBeGreaterThan(0)
  expect(screen.getByRole('status').textContent).toBe('Unavailable')
  expect(loadA).toHaveBeenCalledTimes(1)
  expect(loadB).toHaveBeenCalledTimes(1)
})
