import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  DispatchNodeResponseKeyEnum,
  SseResponseEventEnum
} from '@fastgpt/global/core/workflow/runtime/constants';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import type {
  ChatDispatchProps,
  ModuleDispatchProps
} from '@fastgpt/global/core/workflow/runtime/type';
import type { RuntimeNodeItemType } from '@fastgpt/global/core/workflow/runtime/type.d';
import type {
  AIChatItemValueItemType,
  ChatHistoryItemResType,
  NodeOutputItemType,
  ToolRunResponseItemType
} from '@fastgpt/global/core/chat/type.d';
import {
  FlowNodeInputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { getNanoid, replaceVariable } from '@fastgpt/global/common/string/tools';
import { getSystemTime } from '@fastgpt/global/common/time/timezone';
import { replaceEditorVariable } from '@fastgpt/global/core/workflow/utils';

import { dispatchWorkflowStart } from './init/workflowStart';
import { dispatchChatCompletion } from './chat/oneapi';
import { dispatchDatasetSearch } from './dataset/search';
import { dispatchDatasetConcat } from './dataset/concat';
import { dispatchAnswer } from './tools/answer';
import { dispatchClassifyQuestion } from './agent/classifyQuestion';
import { dispatchContentExtract } from './agent/extract';
import { dispatchHttp468Request } from './tools/http468';
import { dispatchAppRequest } from './tools/runApp';
import { dispatchQueryExtension } from './tools/queryExternsion';
import { dispatchRunPlugin } from './plugin/run';
import { dispatchPluginInput } from './plugin/runInput';
import { dispatchPluginOutput } from './plugin/runOutput';
import { removeSystemVariable, valueTypeFormat } from './utils';
import {
  filterWorkflowEdges,
  checkNodeRunStatus
} from '@fastgpt/global/core/workflow/runtime/utils';
import { ChatNodeUsageType } from '@fastgpt/global/support/wallet/bill/type';
import { dispatchRunTools } from './agent/runTool/index';
import { ChatItemValueTypeEnum } from '@fastgpt/global/core/chat/constants';
import { DispatchFlowResponse } from './type';
import { dispatchStopToolCall } from './agent/runTool/stopTool';
import { dispatchLafRequest } from './tools/runLaf';
import { dispatchIfElse } from './tools/runIfElse';
import { RuntimeEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import { getReferenceVariableValue } from '@fastgpt/global/core/workflow/runtime/utils';
import { dispatchSystemConfig } from './init/systemConfig';
import { dispatchUpdateVariable } from './tools/runUpdateVar';
import { addLog } from '../../../common/system/log';
import { surrenderProcess } from '../../../common/system/tools';
import { dispatchRunCode } from './code/run';
import { dispatchTextEditor } from './tools/textEditor';
import { dispatchCustomFeedback } from './tools/customFeedback';
import { dispatchReadFiles } from './tools/readFiles';
import { dispatchUserSelect } from './interactive/userSelect';
import {
  InteractiveNodeResponseItemType,
  UserSelectInteractive
} from '@fastgpt/global/core/workflow/template/system/userSelect/type';
import { dispatchRunAppNode } from './agent/runAppModule';

const callbackMap: Record<FlowNodeTypeEnum, Function> = {
  [FlowNodeTypeEnum.workflowStart]: dispatchWorkflowStart,
  [FlowNodeTypeEnum.answerNode]: dispatchAnswer,
  [FlowNodeTypeEnum.chatNode]: dispatchChatCompletion,
  [FlowNodeTypeEnum.datasetSearchNode]: dispatchDatasetSearch,
  [FlowNodeTypeEnum.datasetConcatNode]: dispatchDatasetConcat,
  [FlowNodeTypeEnum.classifyQuestion]: dispatchClassifyQuestion,
  [FlowNodeTypeEnum.contentExtract]: dispatchContentExtract,
  [FlowNodeTypeEnum.httpRequest468]: dispatchHttp468Request,
  [FlowNodeTypeEnum.runApp]: dispatchAppRequest,
  [FlowNodeTypeEnum.appModule]: dispatchRunAppNode,
  [FlowNodeTypeEnum.pluginModule]: dispatchRunPlugin,
  [FlowNodeTypeEnum.pluginInput]: dispatchPluginInput,
  [FlowNodeTypeEnum.pluginOutput]: dispatchPluginOutput,
  [FlowNodeTypeEnum.queryExtension]: dispatchQueryExtension,
  [FlowNodeTypeEnum.tools]: dispatchRunTools,
  [FlowNodeTypeEnum.stopTool]: dispatchStopToolCall,
  [FlowNodeTypeEnum.lafModule]: dispatchLafRequest,
  [FlowNodeTypeEnum.ifElseNode]: dispatchIfElse,
  [FlowNodeTypeEnum.variableUpdate]: dispatchUpdateVariable,
  [FlowNodeTypeEnum.code]: dispatchRunCode,
  [FlowNodeTypeEnum.textEditor]: dispatchTextEditor,
  [FlowNodeTypeEnum.customFeedback]: dispatchCustomFeedback,
  [FlowNodeTypeEnum.readFiles]: dispatchReadFiles,
  [FlowNodeTypeEnum.userSelect]: dispatchUserSelect,

  // none
  [FlowNodeTypeEnum.systemConfig]: dispatchSystemConfig,
  [FlowNodeTypeEnum.emptyNode]: () => Promise.resolve(),
  [FlowNodeTypeEnum.globalVariable]: () => Promise.resolve()
};

type Props = ChatDispatchProps & {
  runtimeNodes: RuntimeNodeItemType[];
  runtimeEdges: RuntimeEdgeItemType[];
};

/* running */
export async function dispatchWorkFlow(data: Props): Promise<DispatchFlowResponse> {
  let {
    res,
    runtimeNodes = [],
    runtimeEdges = [],
    histories = [],
    variables = {},
    user,
    stream = false,
    ...props
  } = data;

  // set sse response headers
  if (stream && res) {
    res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
  }

  variables = {
    ...getSystemVariable(data),
    ...variables
  };

  let chatResponses: ChatHistoryItemResType[] = []; // response request and save to database
  let chatAssistantResponse: AIChatItemValueItemType[] = []; // The value will be returned to the user
  let chatNodeUsages: ChatNodeUsageType[] = [];
  let toolRunResponse: ToolRunResponseItemType;
  let debugNextStepRunNodes: RuntimeNodeItemType[] = [];

  /* Store special response field  */
  function pushStore(
    { inputs = [] }: RuntimeNodeItemType,
    {
      answerText = '',
      responseData,
      nodeDispatchUsages,
      toolResponses,
      assistantResponses
    }: {
      [NodeOutputKeyEnum.answerText]?: string;
      [DispatchNodeResponseKeyEnum.nodeResponse]?: ChatHistoryItemResType;
      [DispatchNodeResponseKeyEnum.nodeDispatchUsages]?: ChatNodeUsageType[];
      [DispatchNodeResponseKeyEnum.toolResponses]?: ToolRunResponseItemType;
      [DispatchNodeResponseKeyEnum.assistantResponses]?: AIChatItemValueItemType[]; // tool module, save the response value
    }
  ) {
    if (responseData) {
      chatResponses.push(responseData);
    }
    if (nodeDispatchUsages) {
      chatNodeUsages = chatNodeUsages.concat(nodeDispatchUsages);
    }
    if (toolResponses !== undefined) {
      if (Array.isArray(toolResponses) && toolResponses.length === 0) return;
      if (typeof toolResponses === 'object' && Object.keys(toolResponses).length === 0) {
        return;
      }
      toolRunResponse = toolResponses;
    }
    if (assistantResponses) {
      chatAssistantResponse = chatAssistantResponse.concat(assistantResponses);
    } else if (answerText) {
      // save assistant text response
      const isResponseAnswerText =
        inputs.find((item) => item.key === NodeInputKeyEnum.aiChatIsResponseText)?.value ?? true;
      if (isResponseAnswerText) {
        chatAssistantResponse.push({
          type: ChatItemValueTypeEnum.text,
          text: {
            content: answerText
          }
        });
      }
    }
  }
  /* Pass the output of the node, to get next nodes and update edge status */
  function nodeOutput(
    node: RuntimeNodeItemType,
    result: Record<string, any> = {}
  ): RuntimeNodeItemType[] {
    pushStore(node, result);

    // Assign the output value to the next node
    node.outputs.forEach((outputItem) => {
      if (result[outputItem.key] === undefined) return;
      /* update output value */
      outputItem.value = result[outputItem.key];
    });

    // Get next source edges and update status
    const skipHandleId = (result[DispatchNodeResponseKeyEnum.skipHandleId] || []) as string[];
    const targetEdges = filterWorkflowEdges(runtimeEdges).filter(
      (item) => item.source === node.nodeId
    );

    // update edge status
    targetEdges.forEach((edge) => {
      if (skipHandleId.includes(edge.sourceHandle)) {
        edge.status = 'skipped';
      } else {
        edge.status = 'active';
      }
    });

    const nextStepNodes = runtimeNodes.filter((node) => {
      return targetEdges.some((item) => item.target === node.nodeId);
    });

    if (props.mode === 'debug') {
      debugNextStepRunNodes = debugNextStepRunNodes.concat(nextStepNodes);
      return [];
    }

    return nextStepNodes;
  }

  /* Have interactive result, computed edges and node outputs */
  function handleInteractiveResult({
    entryNodeIds,
    interactiveResponse
  }: {
    entryNodeIds: string[];
    interactiveResponse: UserSelectInteractive;
  }): AIChatItemValueItemType {
    // Get node outputs
    const nodeOutputs: NodeOutputItemType[] = [];
    runtimeNodes.forEach((node) => {
      node.outputs.forEach((output) => {
        if (output.value) {
          nodeOutputs.push({
            nodeId: node.nodeId,
            key: output.key as NodeOutputKeyEnum,
            value: output.value
          });
        }
      });
    });

    const interactiveResult: InteractiveNodeResponseItemType = {
      ...interactiveResponse,
      entryNodeIds,
      memoryEdges: runtimeEdges.map((edge) => ({
        ...edge,
        status: entryNodeIds.includes(edge.target)
          ? 'active'
          : entryNodeIds.includes(edge.source)
            ? 'waiting'
            : edge.status
      })),
      nodeOutputs
    };

    props.workflowStreamResponse?.({
      event: SseResponseEventEnum.interactive,
      data: { interactive: interactiveResult }
    });

    return {
      type: ChatItemValueTypeEnum.interactive,
      interactive: interactiveResult
    };
  }

  // 每个节点 运行/跳过 后，初始化边的状态
  function nodeRunAfterHook(node: RuntimeNodeItemType) {
    node.isEntry = false;

    runtimeEdges.forEach((item) => {
      if (item.target === node.nodeId) {
        item.status = 'waiting';
      }
    });
  }
  /* Check node run/skip or wait */
  function checkNodeCanRun(nodes: RuntimeNodeItemType[] = []): Promise<any> {
    return Promise.all(
      nodes.map(async (node) => {
        const status = checkNodeRunStatus({
          node,
          runtimeEdges
        });

        if (res?.closed || props.maxRunTimes <= 0) return;

        addLog.debug(`Run node`, { maxRunTimes: props.maxRunTimes, uid: user._id });

        // Thread avoidance
        await surrenderProcess();

        if (status === 'run') {
          addLog.debug(`[dispatchWorkFlow] nodeRunWithActive: ${node.name}`);
          return nodeRunWithActive(node);
        }
        if (status === 'skip') {
          addLog.debug(`[dispatchWorkFlow] nodeRunWithSkip: ${node.name}`);
          return nodeRunWithSkip(node);
        }

        return;
      })
    ).then((result) => {
      props.maxRunTimes--;

      const flat = result.flat().filter(Boolean) as unknown as {
        node: RuntimeNodeItemType;
        runStatus: 'run' | 'skip';
        result: Record<string, any>;
      }[];
      // If there are no running nodes, the workflow is complete
      if (flat.length === 0) return;

      // Update the node output at the end of the run and get the next nodes
      const nextNodes = flat.map((item) => nodeOutput(item.node, item.result)).flat();
      // Remove repeat nodes(Make sure that the node is only executed once)
      const filterNextNodes = nextNodes.filter(
        (node, index, self) => self.findIndex((t) => t.nodeId === node.nodeId) === index
      );

      // In the current version, only one interactive node is allowed at the same time
      const haveInteractiveResponse = flat
        .map((response) => {
          const interactiveResponse = response.result?.[DispatchNodeResponseKeyEnum.interactive];
          if (interactiveResponse) {
            chatAssistantResponse.push(
              handleInteractiveResult({
                entryNodeIds: [response.node.nodeId],
                interactiveResponse
              })
            );
            return 1;
          }
        })
        .filter(Boolean);
      if (haveInteractiveResponse.length > 0) return;

      return checkNodeCanRun(filterNextNodes);
    });
  }
  /* Inject data into module input */
  function getNodeRunParams(node: RuntimeNodeItemType) {
    if (node.flowNodeType === FlowNodeTypeEnum.pluginInput) {
      // Format plugin input to object
      return node.inputs.reduce<Record<string, any>>((acc, item) => {
        acc[item.key] = valueTypeFormat(item.value, item.valueType);
        return acc;
      }, {});
    }

    // Dynamic input need to store a key.
    const dynamicInput = node.inputs.find(
      (item) => item.renderTypeList[0] === FlowNodeInputTypeEnum.addInputParam
    );
    const params: Record<string, any> = dynamicInput
      ? {
          [dynamicInput.key]: {}
        }
      : {};

    node.inputs.forEach((input) => {
      if (input.key === dynamicInput?.key) return;

      // replace {{xx}} variables
      let value = replaceVariable(input.value, variables);

      // replace {{$xx.xx$}} variables
      value = replaceEditorVariable({
        text: value,
        nodes: runtimeNodes,
        variables,
        runningNode: node
      });

      // replace reference variables
      value = getReferenceVariableValue({
        value,
        nodes: runtimeNodes,
        variables
      });

      // Dynamic input is stored in the dynamic key
      if (input.canEdit && dynamicInput && params[dynamicInput.key]) {
        params[dynamicInput.key][input.key] = valueTypeFormat(value, input.valueType);
      }

      params[input.key] = valueTypeFormat(value, input.valueType);
    });

    return params;
  }
  async function nodeRunWithActive(node: RuntimeNodeItemType) {
    // push run status messages
    if (node.showStatus) {
      props.workflowStreamResponse?.({
        event: SseResponseEventEnum.flowNodeStatus,
        data: {
          status: 'running',
          name: node.name
        }
      });
    }
    const startTime = Date.now();

    // get node running params
    const params = getNodeRunParams(node);

    const dispatchData: ModuleDispatchProps<Record<string, any>> = {
      ...props,
      res,
      variables,
      histories,
      user,
      stream,
      node,
      runtimeNodes,
      runtimeEdges,
      params,
      mode: props.mode === 'debug' ? 'test' : props.mode
    };

    // run module
    const dispatchRes: Record<string, any> = await (async () => {
      if (callbackMap[node.flowNodeType]) {
        return callbackMap[node.flowNodeType](dispatchData);
      }
      return {};
    })();

    // format response data. Add modulename and module type
    const formatResponseData: ChatHistoryItemResType = (() => {
      if (!dispatchRes[DispatchNodeResponseKeyEnum.nodeResponse]) return undefined;
      return {
        id: getNanoid(),
        nodeId: node.nodeId,
        moduleName: node.name,
        moduleType: node.flowNodeType,
        runningTime: +((Date.now() - startTime) / 1000).toFixed(2),
        ...dispatchRes[DispatchNodeResponseKeyEnum.nodeResponse]
      };
    })();

    // Add output default value
    node.outputs.forEach((item) => {
      if (!item.required) return;
      if (dispatchRes[item.key] !== undefined) return;
      dispatchRes[item.key] = valueTypeFormat(item.defaultValue, item.valueType);
    });

    nodeRunAfterHook(node);

    return {
      node,
      runStatus: 'run',
      result: {
        ...dispatchRes,
        [DispatchNodeResponseKeyEnum.nodeResponse]: formatResponseData
      }
    };
  }
  async function nodeRunWithSkip(node: RuntimeNodeItemType) {
    // 其后所有target的节点，都设置为skip
    const targetEdges = runtimeEdges.filter((item) => item.source === node.nodeId);
    nodeRunAfterHook(node);

    return {
      node,
      runStatus: 'skip',
      result: {
        [DispatchNodeResponseKeyEnum.skipHandleId]: targetEdges.map((item) => item.sourceHandle)
      }
    };
  }

  // start process width initInput
  const entryNodes = runtimeNodes.filter((item) => item.isEntry);

  // reset entry
  // runtimeNodes.forEach((item) => {
  //   item.isEntry = false;
  // });
  await checkNodeCanRun(entryNodes);

  // focus try to run pluginOutput
  const pluginOutputModule = runtimeNodes.find(
    (item) => item.flowNodeType === FlowNodeTypeEnum.pluginOutput
  );
  if (pluginOutputModule && props.mode !== 'debug') {
    await nodeRunWithActive(pluginOutputModule);
  }

  return {
    flowResponses: chatResponses,
    flowUsages: chatNodeUsages,
    debugResponse: {
      finishedNodes: runtimeNodes,
      finishedEdges: runtimeEdges,
      nextStepRunNodes: debugNextStepRunNodes
    },
    [DispatchNodeResponseKeyEnum.assistantResponses]:
      mergeAssistantResponseAnswerText(chatAssistantResponse),
    [DispatchNodeResponseKeyEnum.toolResponses]: toolRunResponse,
    newVariables: removeSystemVariable(variables)
  };
}

/* get system variable */
export function getSystemVariable({
  user,
  app,
  chatId,
  responseChatItemId,
  histories = []
}: Props) {
  return {
    appId: String(app._id),
    chatId,
    responseChatItemId,
    histories,
    cTime: getSystemTime(user.timezone)
  };
}

/* Merge consecutive text messages into one */
export const mergeAssistantResponseAnswerText = (response: AIChatItemValueItemType[]) => {
  const result: AIChatItemValueItemType[] = [];
  // 合并连续的text
  for (let i = 0; i < response.length; i++) {
    const item = response[i];
    if (item.type === ChatItemValueTypeEnum.text) {
      let text = item.text?.content || '';
      const lastItem = result[result.length - 1];
      if (lastItem && lastItem.type === ChatItemValueTypeEnum.text && lastItem.text?.content) {
        lastItem.text.content += text;
        continue;
      }
    }
    result.push(item);
  }

  return result;
};
