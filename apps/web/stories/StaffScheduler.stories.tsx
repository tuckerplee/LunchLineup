import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { StaffScheduler } from '../components/scheduling/StaffScheduler';

const resources = [
  { id: 'person-a', title: 'Alex Rivera', role: 'SERVER', avatarInitials: 'AR', hue: 215 },
  { id: 'person-b', title: 'Blair Chen', role: 'MANAGER', avatarInitials: 'BC', hue: 145 },
];

const events = [
  {
    id: 'draft-shift',
    resourceId: 'person-a',
    title: 'Alex Rivera',
    start: '2026-07-09T17:00:00.000Z',
    end: '2026-07-10T01:00:00.000Z',
    extendedProps: { role: 'SERVER' },
  },
  {
    id: 'draft-break',
    resourceId: 'person-a',
    title: 'Break',
    start: '2026-07-09T19:00:00.000Z',
    end: '2026-07-09T19:15:00.000Z',
    extendedProps: { role: 'SERVER', kind: 'break' as const },
  },
  {
    id: 'published-shift',
    resourceId: 'person-b',
    title: 'Blair Chen',
    start: '2026-07-09T18:00:00.000Z',
    end: '2026-07-10T02:00:00.000Z',
    extendedProps: { role: 'MANAGER', published: true },
  },
];

const meta = {
  title: 'Scheduling/StaffScheduler',
  component: StaffScheduler,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: 520, padding: 20, background: '#f5f7fb' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    resources,
    events,
    viewMode: 'day',
    initialDate: '2026-07-09',
    timeZone: 'America/Los_Angeles',
    onEventChange: fn(),
    onEventCopy: fn(),
    onEventSelect: fn(),
  },
} satisfies Meta<typeof StaffScheduler>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccessibleGestureContract: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const draftDetails = canvas.getByRole('button', { name: /Edit Alex Rivera shift/ });
    const draftHandle = canvas.getByRole('button', { name: 'Move or copy Alex Rivera' });
    const publishedDetails = canvas.getByRole('button', { name: /View Blair Chen shift.*published/ });
    const publishedHandle = canvas.getByRole('button', { name: /Blair Chen is published/ });
    const sourceRow = canvasElement.querySelector<HTMLElement>('[data-resource-id="person-a"]');
    const targetRow = canvasElement.querySelector<HTMLElement>('[data-resource-id="person-b"]');
    const board = canvasElement.querySelector<HTMLElement>('[data-scheduler-board-id]');

    expect(sourceRow).not.toBeNull();
    expect(targetRow).not.toBeNull();
    expect(board).not.toBeNull();
    if (!sourceRow || !targetRow || !board) return;

    await userEvent.click(draftDetails);
    expect(args.onEventSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-shift' }));
    expect(getComputedStyle(draftDetails).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(draftHandle).touchAction).toBe('none');

    const handleBox = draftHandle.getBoundingClientRect();
    const targetBox = targetRow.getBoundingClientRect();
    const boardBox = board.getBoundingClientRect();
    const startX = handleBox.left + handleBox.width / 2;
    const startY = handleBox.top + handleBox.height / 2;
    const targetY = targetBox.top + targetBox.height / 2;

    await fireEvent.pointerDown(draftHandle, { pointerId: 11, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 11, pointerType: 'mouse', clientX: startX + 7, clientY: startY });
    await fireEvent.pointerUp(draftHandle, { pointerId: 11, pointerType: 'mouse', clientX: startX + 7, clientY: startY });
    expect(args.onEventChange).not.toHaveBeenCalled();

    await fireEvent.pointerDown(draftHandle, { pointerId: 12, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 12, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    await fireEvent.pointerUp(draftHandle, { pointerId: 12, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    expect(args.onEventChange).toHaveBeenCalledTimes(1);
    expect(args.onEventChange).toHaveBeenLastCalledWith(
      'draft-shift',
      '2026-07-09T17:15:00.000Z',
      '2026-07-10T01:15:00.000Z',
      'person-b',
    );

    await fireEvent.pointerDown(draftHandle, { pointerId: 13, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 13, pointerType: 'mouse', clientX: boardBox.right + 20, clientY: startY });
    await fireEvent.pointerUp(draftHandle, { pointerId: 13, pointerType: 'mouse', clientX: boardBox.right + 20, clientY: startY });
    expect(args.onEventChange).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(draftHandle, { pointerId: 14, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 14, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerUp(draftHandle, { pointerId: 14, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });

    await fireEvent.pointerDown(draftHandle, { pointerId: 15, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 15, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    await fireEvent.pointerCancel(draftHandle, { pointerId: 15, pointerType: 'mouse' });

    await fireEvent.pointerDown(draftHandle, { pointerId: 16, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 16, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    await fireEvent.blur(window);
    expect(args.onEventChange).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(draftHandle, { pointerId: 161, pointerType: 'mouse', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 161, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    await fireEvent.lostPointerCapture(draftHandle, { pointerId: 161, pointerType: 'mouse' });
    await fireEvent.pointerUp(draftHandle, { pointerId: 161, pointerType: 'mouse', clientX: startX + 18, clientY: targetY });
    expect(args.onEventChange).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(draftHandle, { pointerId: 17, pointerType: 'touch', button: 0, clientX: startX, clientY: startY });
    await fireEvent.pointerMove(draftHandle, { pointerId: 17, pointerType: 'touch', clientX: startX + 9, clientY: startY });
    await fireEvent.pointerUp(draftHandle, { pointerId: 17, pointerType: 'touch', clientX: startX + 9, clientY: startY });
    expect(args.onEventChange).toHaveBeenCalledTimes(1);

    await fireEvent.pointerDown(draftHandle, { pointerId: 18, pointerType: 'touch', button: 0, clientX: startX, clientY: startY });
    await new Promise((resolve) => window.setTimeout(resolve, 320));
    expect(canvasElement.querySelector('.shift-block--source-ghost')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.pointerUp(draftHandle, { pointerId: 18, pointerType: 'touch', clientX: startX, clientY: startY });
    expect(args.onEventChange).toHaveBeenCalledTimes(1);

    draftHandle.focus();
    await fireEvent.keyDown(draftHandle, { key: 'Enter' });
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog', { name: 'Move or copy shift' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Team member'), 'person-b');
    await fireEvent.change(within(dialog).getByLabelText('Time adjustment in minutes'), { target: { value: '30' } });
    const applyMove = within(dialog).getByRole('button', { name: 'Apply move' });
    await waitFor(() => expect(applyMove).toBeEnabled());
    await userEvent.click(applyMove);
    await waitFor(() => expect(args.onEventChange).toHaveBeenCalledTimes(2));
    expect(args.onEventChange).toHaveBeenLastCalledWith(
      'draft-shift',
      '2026-07-09T17:30:00.000Z',
      '2026-07-10T01:30:00.000Z',
      'person-b',
    );

    expect(publishedHandle).toBeDisabled();
    await userEvent.click(publishedDetails);
    expect(args.onEventSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'published-shift' }));
    expect(canvas.getByRole('listitem', { name: /Break 12:00 to 12:15/ })).toBeVisible();
  },
};
