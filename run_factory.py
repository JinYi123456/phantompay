import asyncio
import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from band import Agent, configure_logging
from band.adapters import LangGraphAdapter
from band.config import load_agent_config

async def run_single_agent(config_key: str):
    agent_id, api_key = load_agent_config(config_key)
    
    # 接入 GonkaRouter 网关
    adapter = LangGraphAdapter(
        llm=ChatOpenAI(
            model="zai-org/GLM-5.3-Flash",  # 也可以换成 deepseek-ai/DeepSeek-V4-Flash-0731
            base_url="https://api.gonkarouter.io/v1",
            api_key=os.getenv("GONKAROUTER_API_KEY")
        ),
        checkpointer=InMemorySaver(),
    )
    
    agent = Agent.create(
        adapter=adapter,
        agent_id=agent_id,
        api_key=api_key,
    )
    print(f"[{config_key}] Agent successfully connected to Band via GonkaRouter!")
    await agent.run()

async def main():
    load_dotenv()
    configure_logging(root_level="INFO")
    
    # 同时并发启动这四个工厂角色
    await asyncio.gather(
        run_single_agent("architect"),
        run_single_agent("implementer"),
        run_single_agent("reviewer"),
        run_single_agent("verifier"),
    )

if __name__ == "__main__":
    asyncio.run(main())